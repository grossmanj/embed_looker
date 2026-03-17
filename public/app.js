(() => {
  const DEFAULT_DASHBOARD_ID = "1327";
  const PROACTIVE_REFRESH_MS = 8 * 60 * 1000;
  const WATCHDOG_INTERVAL_MS = 30 * 1000;
  const RESUME_GAP_MS = 90 * 1000;
  const RESUME_REFRESH_COOLDOWN_MS = 15 * 1000;

  const iframe = document.getElementById("dashboard-frame");
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");
  const errorOverlay = document.getElementById("error-overlay");
  const errorText = document.getElementById("error-text");
  const retryButton = document.getElementById("retry-btn");

  const dashboardId = getDashboardIdFromPath();

  let loadInFlight = false;
  let hasLoadedAtLeastOnce = false;
  let lookerOrigin = null;
  let tokenRequestInFlight = false;
  let lastSuccessfulEmbedAt = 0;
  let lastWatchdogTick = Date.now();
  let lastResumeRefreshAt = 0;

  updateViewportHeight();
  window.addEventListener("resize", updateViewportHeight);
  window.addEventListener("orientationchange", updateViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateViewportHeight);
  }

  iframe.addEventListener("load", () => {
    hideError();
    setLoading(false);
    hasLoadedAtLeastOnce = true;
  });

  retryButton.addEventListener("click", () => {
    void loadDashboard({ interactive: true, force: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      triggerResumeRefresh();
    }
  });
  window.addEventListener("focus", triggerResumeRefresh);
  window.addEventListener("pageshow", triggerResumeRefresh);
  window.addEventListener("online", triggerResumeRefresh);
  window.addEventListener("message", (event) => {
    if (!iframe.contentWindow || event.source !== iframe.contentWindow) {
      return;
    }

    if (lookerOrigin && event.origin !== lookerOrigin) {
      return;
    }

    const payload = parseMessagePayload(event.data);
    if (
      !payload ||
      !(
        payload.type === "session:tokens:request" ||
        payload.type === "session:tokens"
      ) ||
      payload.api_token ||
      payload.navigation_token
    ) {
      return;
    }

    void sendCookielessTokens();
  });

  setInterval(() => {
    const now = Date.now();
    if (now - lastWatchdogTick > RESUME_GAP_MS) {
      void loadDashboard({ interactive: false, force: true });
    } else if (
      lastSuccessfulEmbedAt > 0 &&
      now - lastSuccessfulEmbedAt >= PROACTIVE_REFRESH_MS
    ) {
      void loadDashboard({ interactive: false, force: true });
    }
    lastWatchdogTick = now;
  }, WATCHDOG_INTERVAL_MS);

  void loadDashboard({ interactive: true, force: true });

  async function loadDashboard({ interactive, force }) {
    if (loadInFlight) {
      return;
    }

    if (!force && Date.now() - lastSuccessfulEmbedAt < 5000) {
      return;
    }

    loadInFlight = true;

    if (!hasLoadedAtLeastOnce) {
      iframe.hidden = true;
      iframe.src = "";
    }

    if (interactive || !hasLoadedAtLeastOnce) {
      setLoading(true, "Loading dashboard...");
    }

    hideError();

    try {
      const response = await fetch(`/api/embed-url/${dashboardId}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          payload?.error?.message ||
            "The server could not create the dashboard embed URL."
        );
      }

      if (!payload?.url) {
        throw new Error("The server returned an invalid embed URL.");
      }

      lookerOrigin = getOrigin(payload.url);
      iframe.src = payload.url;
      iframe.hidden = false;
      lastSuccessfulEmbedAt = Date.now();
      setLoading(false);
    } catch (error) {
      if (hasLoadedAtLeastOnce && !interactive) {
        setLoading(false);
        return;
      }

      showError(
        error.message ||
          "Unable to load the dashboard right now. Please try again."
      );
      setLoading(false);
    } finally {
      loadInFlight = false;
    }
  }

  function triggerResumeRefresh() {
    const now = Date.now();
    if (now - lastResumeRefreshAt < RESUME_REFRESH_COOLDOWN_MS) {
      return;
    }
    lastResumeRefreshAt = now;
    void loadDashboard({ interactive: false, force: true });
  }

  async function sendCookielessTokens() {
    if (tokenRequestInFlight) {
      return;
    }

    tokenRequestInFlight = true;

    try {
      const response = await fetch(`/api/embed-tokens/${dashboardId}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.api_token || !payload?.navigation_token) {
        throw new Error("Failed to refresh embed tokens.");
      }

      if (!iframe.contentWindow || !lookerOrigin) {
        return;
      }

      iframe.contentWindow.postMessage(
        {
          type: "session:tokens",
          api_token: payload.api_token,
          navigation_token: payload.navigation_token,
        },
        lookerOrigin
      );
    } catch (_error) {
      void loadDashboard({ interactive: false, force: true });
    } finally {
      tokenRequestInFlight = false;
    }
  }

  function setLoading(isLoading, message) {
    loadingOverlay.hidden = !isLoading;
    if (message) {
      loadingText.textContent = message;
    }
  }

  function showError(message) {
    errorText.textContent = message;
    errorOverlay.hidden = false;
  }

  function hideError() {
    errorOverlay.hidden = true;
    errorText.textContent = "";
  }

  function getDashboardIdFromPath() {
    const match = window.location.pathname.match(/^\/(\d+)\/?$/);
    return match ? match[1] : DEFAULT_DASHBOARD_ID;
  }

  function updateViewportHeight() {
    const height = window.visualViewport
      ? window.visualViewport.height
      : window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${height}px`);
  }

  function getOrigin(url) {
    try {
      return new URL(url).origin;
    } catch (_error) {
      return null;
    }
  }

  function parseMessagePayload(value) {
    if (value && typeof value === "object") {
      return value;
    }

    if (typeof value !== "string") {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }
})();
