(() => {
  const DEFAULT_KIOSK_REF = "kflax";
  const LOAD_TIMEOUT_MS = 75 * 1000;
  const RESUME_GAP_MS = 90 * 1000;
  const RESUME_REFRESH_COOLDOWN_MS = 15 * 1000;

  const viewport = document.querySelector(".viewport");
  const iframe = document.getElementById("dashboard-frame");
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");
  const errorOverlay = document.getElementById("error-overlay");
  const errorText = document.getElementById("error-text");
  const retryButton = document.getElementById("retry-btn");
  const statusPanel = document.getElementById("kiosk-status");
  const statusText = document.getElementById("kiosk-status-text");

  const kioskRef = getKioskRefFromPath();
  const query = new URLSearchParams(window.location.search);
  const debugEnabled = query.get("debug") === "1";
  const forcedSlotId = String(query.get("slot") || "").trim().toLowerCase();
  const clientSessionIds = new Map();

  let kioskConfig = null;
  let activeSlot = null;
  let activeDashboardRef = null;
  let loadInFlight = false;
  let hasLoadedAtLeastOnce = false;
  let lookerOrigin = null;
  let tokenRequestInFlight = false;
  let lastSuccessfulEmbedAt = 0;
  let lastWatchdogTick = Date.now();
  let lastResumeRefreshAt = 0;
  let loadTimeout = null;
  let healthTimer = null;
  let dashboardLoadArmed = false;
  let scrollAnimationFrame = null;
  let scrollDirection = 1;
  let scrollPauseUntil = 0;
  let lastScrollFrameAt = 0;

  updateViewportHeight();
  window.addEventListener("resize", updateViewportHeight);
  window.addEventListener("orientationchange", updateViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateViewportHeight);
  }

  statusPanel.hidden = !debugEnabled;

  iframe.addEventListener("load", () => {
    if (!dashboardLoadArmed || !isRealIframeSrc(iframe.src)) {
      return;
    }

    dashboardLoadArmed = false;
    clearLoadTimeout();
    hideError();
    setLoading(false);
    hasLoadedAtLeastOnce = true;
    lastSuccessfulEmbedAt = Date.now();
    startAutoScroll();
    updateStatus("loaded");
  });

  retryButton.addEventListener("click", () => {
    void loadActiveDashboard({ interactive: true, force: true, reason: "retry" });
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
    if (!payload || payload.type !== "session:tokens:request") {
      return;
    }

    void sendCookielessTokens(payload, event.origin);
  });

  void boot();

  async function boot() {
    try {
      kioskConfig = await fetchKioskConfig();
      document.title = `${kioskConfig.displayName} Kiosk`;
      configureAutoScroll();
      void loadActiveDashboard({
        interactive: true,
        force: true,
        reason: "boot",
      });

      healthTimer = setInterval(() => {
        void runHealthCheck();
      }, kioskConfig.healthCheckMs);
    } catch (error) {
      showError(error.message || "Kiosk configuration could not be loaded.");
      setLoading(false);
      updateStatus("config error");
    }
  }

  async function runHealthCheck() {
    const now = Date.now();
    const nextSlot = getSelectedSlot();
    const slotChanged = activeSlot && nextSlot.id !== activeSlot.id;
    const stalled = now - lastWatchdogTick > RESUME_GAP_MS;
    const shouldRefresh =
      lastSuccessfulEmbedAt > 0 &&
      now - lastSuccessfulEmbedAt >= kioskConfig.reloadMs;

    lastWatchdogTick = now;

    if (slotChanged) {
      await loadActiveDashboard({
        interactive: false,
        force: true,
        reason: "slot-change",
      });
      return;
    }

    if (stalled || shouldRefresh) {
      await loadActiveDashboard({
        interactive: false,
        force: true,
        reason: stalled ? "resume-gap" : "scheduled-refresh",
      });
      return;
    }

    updateStatus("healthy");
  }

  async function fetchKioskConfig() {
    const response = await fetch(`/api/kiosk-config/${kioskRef}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        payload?.error?.message || "The server could not load kiosk config."
      );
    }

    if (!payload || !Array.isArray(payload.slots) || payload.slots.length === 0) {
      throw new Error("The server returned invalid kiosk config.");
    }

    return payload;
  }

  async function loadActiveDashboard({ interactive, force, reason }) {
    if (!kioskConfig || loadInFlight) {
      return;
    }

    const nextSlot = getSelectedSlot();
    const nextDashboardRef = nextSlot.dashboardRef;

    if (
      !force &&
      activeDashboardRef === nextDashboardRef &&
      Date.now() - lastSuccessfulEmbedAt < 5000
    ) {
      return;
    }

    loadInFlight = true;
    activeSlot = nextSlot;
    activeDashboardRef = nextDashboardRef;
    stopAutoScroll();
    resetAutoScrollPosition();

    if (!hasLoadedAtLeastOnce) {
      iframe.hidden = true;
      iframe.src = "";
    }

    if (interactive || !hasLoadedAtLeastOnce) {
      setLoading(true, "Loading dashboard...");
    }

    hideError();
    updateStatus(reason || "loading");

    try {
      const response = await fetch(getApiUrl("/api/embed-url", activeDashboardRef), {
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
      armLoadTimeout();
      iframe.hidden = false;
      dashboardLoadArmed = true;
      iframe.src = payload.url;
    } catch (error) {
      dashboardLoadArmed = false;
      clearLoadTimeout();
      if (hasLoadedAtLeastOnce && !interactive) {
        setLoading(false);
        updateStatus(`background error: ${error.message || "load failed"}`);
        return;
      }

      showError(
        error.message ||
          "Unable to load the dashboard right now. Please try again."
      );
      setLoading(false);
      updateStatus("load error");
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
    void loadActiveDashboard({
      interactive: false,
      force: true,
      reason: "resume",
    });
  }

  async function sendCookielessTokens(requestMessage, targetOrigin) {
    if (tokenRequestInFlight || !activeDashboardRef) {
      return;
    }

    tokenRequestInFlight = true;

    try {
      const response = await fetch(
        getApiUrl("/api/embed-tokens", activeDashboardRef),
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        }
      );
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.api_token || !payload?.navigation_token) {
        throw new Error("Failed to refresh embed tokens.");
      }

      if (!iframe.contentWindow || !lookerOrigin) {
        return;
      }

      const message = {
        type: "session:tokens",
        api_token: payload.api_token,
        navigation_token: payload.navigation_token,
      };
      if (typeof payload.api_token_ttl === "number") {
        message.api_token_ttl = payload.api_token_ttl;
      }
      if (typeof payload.navigation_token_ttl === "number") {
        message.navigation_token_ttl = payload.navigation_token_ttl;
      }
      if (typeof payload.session_reference_token_ttl === "number") {
        message.session_reference_token_ttl = payload.session_reference_token_ttl;
      }
      if (
        requestMessage &&
        Object.prototype.hasOwnProperty.call(requestMessage, "request_id")
      ) {
        message.request_id = requestMessage.request_id;
      }

      const postOrigin =
        targetOrigin && targetOrigin !== "null" ? targetOrigin : lookerOrigin;
      iframe.contentWindow.postMessage(JSON.stringify(message), postOrigin);
    } catch (_error) {
      void loadActiveDashboard({
        interactive: false,
        force: true,
        reason: "token-refresh-failed",
      });
    } finally {
      tokenRequestInFlight = false;
    }
  }

  function getSelectedSlot() {
    if (forcedSlotId) {
      const forcedSlot = kioskConfig.slots.find((slot) => slot.id === forcedSlotId);
      if (forcedSlot) {
        return forcedSlot;
      }
    }

    const currentMinutes = getZonedMinutes(new Date(), kioskConfig.timeZone);
    const slots = kioskConfig.slots
      .map((slot) => ({
        ...slot,
        startMinutes: parseTimeToMinutes(slot.startsAt),
      }))
      .sort((a, b) => a.startMinutes - b.startMinutes);

    let selected = slots[slots.length - 1];
    for (const slot of slots) {
      if (slot.startMinutes <= currentMinutes) {
        selected = slot;
      }
    }
    return selected;
  }

  function getZonedMinutes(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
    const minute = Number(
      parts.find((part) => part.type === "minute")?.value || 0
    );
    return hour * 60 + minute;
  }

  function parseTimeToMinutes(value) {
    const [hour, minute] = String(value || "00:00")
      .split(":")
      .map((part) => Number(part));
    return hour * 60 + minute;
  }

  function armLoadTimeout() {
    clearLoadTimeout();
    loadTimeout = setTimeout(() => {
      loadTimeout = null;
      dashboardLoadArmed = false;
      if (!hasLoadedAtLeastOnce) {
        showError("Dashboard load timed out.");
        setLoading(false);
      } else {
        void loadActiveDashboard({
          interactive: false,
          force: true,
          reason: "load-timeout",
        });
      }
    }, LOAD_TIMEOUT_MS);
  }

  function clearLoadTimeout() {
    if (loadTimeout) {
      clearTimeout(loadTimeout);
      loadTimeout = null;
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

  function updateStatus(state) {
    if (!debugEnabled || !kioskConfig) {
      return;
    }

    const slot = activeSlot || getSelectedSlot();
    const lastLoad = lastSuccessfulEmbedAt
      ? new Date(lastSuccessfulEmbedAt).toLocaleTimeString("sv-SE", {
          timeZone: kioskConfig.timeZone,
        })
      : "never";
    statusText.textContent = [
      kioskConfig.displayName,
      `state=${state}`,
      `slot=${slot.id}`,
      `dashboard=${slot.dashboardRef}`,
      `scroll=${isAutoScrollEnabled() ? "on" : "off"}`,
      `lastLoad=${lastLoad}`,
    ].join(" | ");
  }

  function configureAutoScroll() {
    if (!isAutoScrollEnabled()) {
      viewport.classList.remove("kiosk-scroll-enabled");
      iframe.style.removeProperty("height");
      return;
    }

    viewport.classList.add("kiosk-scroll-enabled");
    iframe.style.height = `${kioskConfig.autoScroll.frameHeightVh}vh`;
  }

  function startAutoScroll() {
    if (!isAutoScrollEnabled()) {
      return;
    }

    stopAutoScroll();
    resetAutoScrollPosition();
    scrollDirection = 1;
    scrollPauseUntil = Date.now() + kioskConfig.autoScroll.initialPauseMs;
    lastScrollFrameAt = 0;
    scrollAnimationFrame = requestAnimationFrame(stepAutoScroll);
  }

  function stopAutoScroll() {
    if (scrollAnimationFrame) {
      cancelAnimationFrame(scrollAnimationFrame);
      scrollAnimationFrame = null;
    }
    lastScrollFrameAt = 0;
  }

  function resetAutoScrollPosition() {
    if (viewport) {
      viewport.scrollTop = 0;
    }
  }

  function stepAutoScroll(timestamp) {
    if (!isAutoScrollEnabled()) {
      scrollAnimationFrame = null;
      return;
    }

    const now = Date.now();
    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);

    if (maxScroll > 2 && now >= scrollPauseUntil) {
      if (!lastScrollFrameAt) {
        lastScrollFrameAt = timestamp;
      }

      const elapsedSeconds = Math.min(
        Math.max((timestamp - lastScrollFrameAt) / 1000, 0),
        1
      );
      const delta =
        kioskConfig.autoScroll.pixelsPerSecond *
        elapsedSeconds *
        scrollDirection;
      const nextScrollTop = viewport.scrollTop + delta;

      if (scrollDirection > 0 && nextScrollTop >= maxScroll) {
        viewport.scrollTop = maxScroll;
        scrollDirection = -1;
        scrollPauseUntil = now + kioskConfig.autoScroll.pauseMs;
        lastScrollFrameAt = 0;
      } else if (scrollDirection < 0 && nextScrollTop <= 0) {
        viewport.scrollTop = 0;
        scrollDirection = 1;
        scrollPauseUntil = now + kioskConfig.autoScroll.pauseMs;
        lastScrollFrameAt = 0;
      } else {
        viewport.scrollTop = Math.min(Math.max(nextScrollTop, 0), maxScroll);
        lastScrollFrameAt = timestamp;
      }
    } else {
      lastScrollFrameAt = 0;
    }

    scrollAnimationFrame = requestAnimationFrame(stepAutoScroll);
  }

  function isAutoScrollEnabled() {
    return Boolean(kioskConfig?.autoScroll?.enabled && viewport);
  }

  function getKioskRefFromPath() {
    const match = window.location.pathname.match(/^\/kiosk\/([A-Za-z0-9_-]+)\/?$/);
    return match ? match[1].toLowerCase() : DEFAULT_KIOSK_REF;
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

  function isRealIframeSrc(value) {
    return Boolean(value && value !== "about:blank");
  }

  function getApiUrl(basePath, dashboardRef) {
    const safeBase = String(basePath || "").replace(/\/+$/, "");
    return `${safeBase}/${dashboardRef}?clientSessionId=${encodeURIComponent(
      getClientSessionId(dashboardRef)
    )}`;
  }

  function getClientSessionId(dashboardRef) {
    if (!clientSessionIds.has(dashboardRef)) {
      clientSessionIds.set(dashboardRef, createClientSessionId());
    }
    return clientSessionIds.get(dashboardRef);
  }

  function createClientSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
    let id = "";
    for (let i = 0; i < 32; i += 1) {
      id += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return id;
  }

  function parseMessagePayload(value) {
    if (value && typeof value === "object") {
      return value;
    }

    if (typeof value !== "string") {
      return null;
    }

    if (value === "session:tokens:request") {
      return { type: value };
    }

    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") {
        return parseMessagePayload(parsed);
      }
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  window.addEventListener("beforeunload", () => {
    clearLoadTimeout();
    stopAutoScroll();
    if (healthTimer) {
      clearInterval(healthTimer);
    }
  });
})();
