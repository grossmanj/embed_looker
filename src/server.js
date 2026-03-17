require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Keep non-sensitive embed settings static in code to reduce env complexity.
const STATIC_LOOKER_SETTINGS = Object.freeze({
  lookerBaseUrl: "https://nordward.cloud.looker.com",
  embedPathPrefix: "/embed/dashboards",
  defaultDashboardId: "1327",
  frameAncestors: [
    "'self'",
    "https://portal.mangodisplay.com",
    "https://*.mangodisplay.com",
  ],
  externalUserId: "public-dashboard-viewer",
  firstName: "Public",
  lastName: "Viewer",
  permissions: ["see_looks", "see_user_dashboards", "access_data"],
  models: [],
  groupIds: [],
  userAttributes: {},
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const config = loadConfig();
const lookerOrigin = new URL(config.lookerBaseUrl).origin;

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    frameguard: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", lookerOrigin],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: config.frameAncestors,
      },
    },
  })
);

const embedUrlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.embedUrlRateLimitMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please retry shortly.",
      },
    });
  },
});

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir, { index: false }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/:dashboardId(\\d+)", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/embed-url/:dashboardId(\\d+)", embedUrlLimiter, async (req, res) => {
  try {
    const dashboardId = req.params.dashboardId;
    const targetUrl = buildEmbedTargetUrl(config, dashboardId);
    const embedDomain = buildEmbedDomain(req);
    const userAgent = req.get("user-agent") || "embed-looker-cloud-run";
    const lookerAuth = await getLookerAccessToken(config);
    const signedUrl = await getCookielessEmbedUrl(
      config,
      lookerAuth,
      targetUrl,
      embedDomain,
      userAgent
    );

    res.set("Cache-Control", "no-store");
    res.status(200).json({ url: signedUrl, dashboardId });
  } catch (error) {
    const publicError = toPublicError(error);

    console.error("Embed URL generation failed", {
      code: publicError.code,
      statusCode: publicError.statusCode,
      cause: error.message,
      details: error.details,
    });

    res.status(publicError.statusCode).json({
      error: {
        code: publicError.code,
        message: publicError.message,
      },
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Route not found.",
    },
  });
});

const server = app.listen(config.port, () => {
  console.log(
    `Server listening on port ${config.port}. Dashboard route format is /:dashboardId (default ${config.defaultDashboardId}).`
  );
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down.");
  server.close(() => process.exit(0));
});

function loadConfig() {
  const missing = ["LOOKER_CLIENT_ID", "LOOKER_CLIENT_SECRET", "LOOKER_MODELS"].filter(
    (key) => !process.env[key] || process.env[key].trim() === ""
  );

  if (missing.length) {
    failFast(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  const lookerBaseUrl = normalizeLookerBaseUrl(STATIC_LOOKER_SETTINGS.lookerBaseUrl);
  const embedPathPrefix = normalizeEmbedPathPrefix(process.env.LOOKER_EMBED_PATH_PREFIX || STATIC_LOOKER_SETTINGS.embedPathPrefix);
  const frameAncestors = process.env.FRAME_ANCESTORS
    ? parseFrameAncestors(process.env.FRAME_ANCESTORS)
    : [...STATIC_LOOKER_SETTINGS.frameAncestors];
  const defaultDashboardId = normalizeDashboardId(
    STATIC_LOOKER_SETTINGS.defaultDashboardId
  );
  const permissions = parseCsvString(
    process.env.LOOKER_PERMISSIONS ||
      STATIC_LOOKER_SETTINGS.permissions.join(","),
    "LOOKER_PERMISSIONS"
  );
  const models = parseCsvString(
    process.env.LOOKER_MODELS || STATIC_LOOKER_SETTINGS.models.join(","),
    "LOOKER_MODELS"
  );
  const groupIds = process.env.LOOKER_GROUP_IDS
    ? parseGroupIds(process.env.LOOKER_GROUP_IDS)
    : [...STATIC_LOOKER_SETTINGS.groupIds];
  const userAttributes = process.env.LOOKER_USER_ATTRIBUTES_JSON
    ? parseUserAttributes(process.env.LOOKER_USER_ATTRIBUTES_JSON)
    : { ...STATIC_LOOKER_SETTINGS.userAttributes };
  const sessionLength = parsePositiveInt(
    process.env.LOOKER_SESSION_LENGTH || "3600",
    "LOOKER_SESSION_LENGTH"
  );
  const embedUrlRateLimitMax = parsePositiveInt(
    process.env.EMBED_URL_RATE_LIMIT_MAX || "30",
    "EMBED_URL_RATE_LIMIT_MAX"
  );
  const port = parsePositiveInt(process.env.PORT || "8080", "PORT");

  return {
    port,
    lookerBaseUrl,
    embedPathPrefix,
    frameAncestors,
    defaultDashboardId,
    lookerClientId: process.env.LOOKER_CLIENT_ID,
    lookerClientSecret: process.env.LOOKER_CLIENT_SECRET,
    externalUserId: STATIC_LOOKER_SETTINGS.externalUserId,
    firstName: STATIC_LOOKER_SETTINGS.firstName,
    lastName: STATIC_LOOKER_SETTINGS.lastName,
    permissions,
    models,
    groupIds,
    userAttributes,
    sessionLength,
    embedUrlRateLimitMax,
  };
}

function parseFrameAncestors(value) {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    failFast("FRAME_ANCESTORS must contain at least one value.");
  }

  return items;
}

function normalizeLookerBaseUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      failFast("Static lookerBaseUrl must start with http:// or https://.");
    }
    return parsed.origin;
  } catch (_error) {
    failFast("Static lookerBaseUrl must be a valid URL.");
  }
}

function normalizeEmbedPathPrefix(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    failFast("LOOKER_EMBED_PATH_PREFIX must start with '/'.");
  }
  return value.replace(/\/+$/, "");
}

function parseCsvString(value, envName) {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    failFast(`${envName} must contain at least one value.`);
  }

  return items;
}

function parseGroupIds(value) {
  if (!value.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      const numeric = Number(id);
      if (!Number.isInteger(numeric) || numeric < 0) {
        failFast("LOOKER_GROUP_IDS must contain comma-separated integer IDs.");
      }
      return numeric;
    });
}

function parseUserAttributes(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      failFast("LOOKER_USER_ATTRIBUTES_JSON must be a valid JSON object.");
    }
    return parsed;
  } catch (_error) {
    failFast("LOOKER_USER_ATTRIBUTES_JSON must be valid JSON.");
  }
}

function parsePositiveInt(raw, envName) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    failFast(`${envName} must be a positive integer.`);
  }
  return parsed;
}

function normalizeDashboardId(value) {
  const id = String(value || "").trim();
  if (!/^\d+$/.test(id)) {
    failFast("Static defaultDashboardId must be numeric.");
  }
  return id;
}

function buildEmbedTargetUrl(runtimeConfig, dashboardId) {
  const normalizedId = String(dashboardId || "").trim();
  if (!/^\d+$/.test(normalizedId)) {
    throw new ApiError(400, "INVALID_DASHBOARD_ID", "Dashboard ID must be numeric.");
  }

  return new URL(
    `${runtimeConfig.embedPathPrefix}/${normalizedId}`,
    runtimeConfig.lookerBaseUrl
  );
}

function buildEmbedDomain(req) {
  const protocol = req.protocol || "https";
  const host = req.get("host");

  if (!host) {
    throw new ApiError(500, "INVALID_EMBED_DOMAIN", "Could not resolve embed domain.");
  }

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch (_error) {
    throw new ApiError(500, "INVALID_EMBED_DOMAIN", "Could not resolve embed domain.");
  }
}

async function getLookerAccessToken(runtimeConfig) {
  const url = `${runtimeConfig.lookerBaseUrl}/api/4.0/login`;
  const body = new URLSearchParams({
    client_id: runtimeConfig.lookerClientId,
    client_secret: runtimeConfig.lookerClientSecret,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const payload = await readJsonSafely(response);

  if (!response.ok) {
    throw new ApiError(
      502,
      "LOOKER_AUTH_FAILED",
      "Could not authenticate to Looker.",
      extractLookerErrorDetails(payload)
    );
  }

  if (!payload || typeof payload.access_token !== "string") {
    throw new ApiError(
      502,
      "LOOKER_AUTH_FAILED",
      "Looker did not return an access token."
    );
  }

  return {
    accessToken: payload.access_token,
    tokenType: normalizeAuthTokenType(payload.token_type),
  };
}

async function getCookielessEmbedUrl(
  runtimeConfig,
  lookerAuth,
  targetUrl,
  embedDomain,
  userAgent
) {
  const tokens = await acquireCookielessSession(
    runtimeConfig,
    lookerAuth,
    embedDomain,
    userAgent
  );

  targetUrl.searchParams.set("embed_domain", embedDomain);
  targetUrl.searchParams.set("embed_navigation_token", tokens.navigationToken);

  const targetUri = encodeURIComponent(
    `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
  );

  return `${targetUrl.origin}/login/embed/${targetUri}?embed_authentication_token=${encodeURIComponent(tokens.authenticationToken)}`;
}

async function acquireCookielessSession(
  runtimeConfig,
  lookerAuth,
  embedDomain,
  userAgent
) {
  const url = `${runtimeConfig.lookerBaseUrl}/api/4.0/embed/cookieless_session/acquire`;
  const authHeaders = buildAuthorizationHeaderCandidates(lookerAuth);
  const requestBody = {
    session_length: runtimeConfig.sessionLength,
    external_user_id: runtimeConfig.externalUserId,
    first_name: runtimeConfig.firstName,
    last_name: runtimeConfig.lastName,
    permissions: runtimeConfig.permissions,
    models: runtimeConfig.models,
    group_ids: runtimeConfig.groupIds,
    user_attributes: runtimeConfig.userAttributes,
    force_logout_login: true,
    embed_domain: embedDomain,
  };

  let lastFailure = {
    statusCode: 502,
    message: "Could not acquire a cookieless embed session.",
    details: undefined,
  };

  for (const authorization of authHeaders) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": userAgent,
      },
      body: JSON.stringify(requestBody),
    });

    const payload = await readJsonSafely(response);
    const authenticationToken =
      payload && typeof payload.authentication_token === "string"
        ? payload.authentication_token
        : "";
    const navigationToken =
      payload && typeof payload.navigation_token === "string"
        ? payload.navigation_token
        : "";

    if (response.ok && authenticationToken && navigationToken) {
      return {
        authenticationToken,
        navigationToken,
      };
    }

    lastFailure = {
      statusCode: response.status || 502,
      message: !response.ok
        ? "Could not acquire a cookieless embed session."
        : "Looker cookieless response did not include required tokens.",
      details: {
        ...(extractLookerErrorDetails(payload) || {}),
        auth_scheme: authorization.split(" ")[0],
        status: response.status || undefined,
      },
    };
  }

  throw new ApiError(
    502,
    "LOOKER_EMBED_FAILED",
    lastFailure.message,
    lastFailure.details
  );
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function toPublicError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  return new ApiError(
    500,
    "INTERNAL_ERROR",
    "Unexpected server error while creating embed URL."
  );
}

function failFast(message) {
  console.error(message);
  process.exit(1);
}

function normalizeAuthTokenType(tokenType) {
  const normalized = String(tokenType || "").trim().toLowerCase();
  if (normalized === "bearer") {
    return "Bearer";
  }
  if (normalized === "token") {
    return "token";
  }
  return "Bearer";
}

function buildAuthorizationHeaderCandidates(lookerAuth) {
  const candidates = [];
  const seen = new Set();

  const raw = lookerAuth.accessToken;
  const first = `${lookerAuth.tokenType} ${raw}`;
  const bearer = `Bearer ${raw}`;
  const token = `token ${raw}`;

  for (const candidate of [first, bearer, token]) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function extractLookerErrorDetails(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  if (typeof payload.message === "string") {
    return { message: payload.message };
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    if (typeof first === "string") {
      return { error: first };
    }
    if (first && typeof first === "object") {
      const summary = {};
      for (const key of ["field", "code", "message"]) {
        if (typeof first[key] === "string") {
          summary[key] = first[key];
        }
      }
      return Object.keys(summary).length ? summary : undefined;
    }
  }

  return undefined;
}

class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
