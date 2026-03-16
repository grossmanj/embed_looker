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
  externalUserId: "public-dashboard-viewer",
  firstName: "Public",
  lastName: "Viewer",
  permissions: ["see_looks", "see_user_dashboards", "access_data"],
  models: ["your_model"],
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
        frameAncestors: ["'self'"],
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
    const embedTargetUrl = buildEmbedTargetUrl(config, dashboardId);
    const accessToken = await getLookerAccessToken(config);
    const signedUrl = await getSignedEmbedUrl(config, accessToken, embedTargetUrl);

    res.status(200).json({ url: signedUrl, dashboardId });
  } catch (error) {
    const publicError = toPublicError(error);

    console.error("Embed URL generation failed", {
      code: publicError.code,
      statusCode: publicError.statusCode,
      cause: error.message,
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
  const missing = ["LOOKER_CLIENT_ID", "LOOKER_CLIENT_SECRET"].filter(
    (key) => !process.env[key] || process.env[key].trim() === ""
  );

  if (missing.length) {
    failFast(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  const lookerBaseUrl = normalizeLookerBaseUrl(STATIC_LOOKER_SETTINGS.lookerBaseUrl);
  const embedPathPrefix = normalizeEmbedPathPrefix(
    STATIC_LOOKER_SETTINGS.embedPathPrefix
  );
  const defaultDashboardId = normalizeDashboardId(
    STATIC_LOOKER_SETTINGS.defaultDashboardId
  );
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
    defaultDashboardId,
    lookerClientId: process.env.LOOKER_CLIENT_ID,
    lookerClientSecret: process.env.LOOKER_CLIENT_SECRET,
    externalUserId: STATIC_LOOKER_SETTINGS.externalUserId,
    firstName: STATIC_LOOKER_SETTINGS.firstName,
    lastName: STATIC_LOOKER_SETTINGS.lastName,
    permissions: [...STATIC_LOOKER_SETTINGS.permissions],
    models: [...STATIC_LOOKER_SETTINGS.models],
    groupIds: [...STATIC_LOOKER_SETTINGS.groupIds],
    userAttributes: { ...STATIC_LOOKER_SETTINGS.userAttributes },
    sessionLength,
    embedUrlRateLimitMax,
  };
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
    failFast("Static embedPathPrefix must start with '/'.");
  }
  return value.replace(/\/+$/, "");
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

  const targetPath = `${runtimeConfig.embedPathPrefix}/${normalizedId}`;
  const targetUrl = new URL(targetPath, runtimeConfig.lookerBaseUrl);
  return targetUrl.toString();
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
      "Could not authenticate to Looker."
    );
  }

  if (!payload || typeof payload.access_token !== "string") {
    throw new ApiError(
      502,
      "LOOKER_AUTH_FAILED",
      "Looker did not return an access token."
    );
  }

  return payload.access_token;
}

async function getSignedEmbedUrl(runtimeConfig, accessToken, targetUrl) {
  const url = `${runtimeConfig.lookerBaseUrl}/api/4.0/embed/sso_url`;
  const requestBody = {
    target_url: targetUrl,
    session_length: runtimeConfig.sessionLength,
    external_user_id: runtimeConfig.externalUserId,
    first_name: runtimeConfig.firstName,
    last_name: runtimeConfig.lastName,
    permissions: runtimeConfig.permissions,
    models: runtimeConfig.models,
    group_ids: runtimeConfig.groupIds,
    user_attributes: runtimeConfig.userAttributes,
    force_logout_login: true,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const payload = await readJsonSafely(response);

  if (!response.ok) {
    throw new ApiError(
      502,
      "LOOKER_EMBED_FAILED",
      "Could not generate a signed embed URL."
    );
  }

  const signedUrl = payload && (payload.url || payload.sso_url);
  if (!signedUrl) {
    throw new ApiError(
      502,
      "LOOKER_EMBED_FAILED",
      "Looker response did not include a signed embed URL."
    );
  }

  return signedUrl;
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

class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
