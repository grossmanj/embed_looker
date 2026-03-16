(() => {
  const DEFAULT_DASHBOARD_ID = "1327";

  const iframe = document.getElementById("dashboard-frame");
  const loading = document.getElementById("loading");
  const errorBanner = document.getElementById("error-banner");
  const errorText = document.getElementById("error-text");
  const retryButton = document.getElementById("retry-btn");
  const statusText = document.getElementById("status-text");
  const dashboardIdText = document.getElementById("dashboard-id");

  retryButton.addEventListener("click", () => {
    loadDashboard();
  });

  loadDashboard();

  async function loadDashboard() {
    const dashboardId = getDashboardIdFromPath();

    if (dashboardIdText) {
      dashboardIdText.textContent = dashboardId;
    }

    setLoading(true, "Requesting a secure embed URL...");
    hideError();
    iframe.hidden = true;
    iframe.src = "";

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

      setLoading(true, "Loading dashboard content...");
      iframe.src = payload.url;
      iframe.hidden = false;

      await waitForFrameLoad(iframe, 25000);
      setLoading(false, "Dashboard loaded.");
    } catch (error) {
      showError(
        error.message ||
          "Unable to load the dashboard right now. Please try again."
      );
      setLoading(false, "Dashboard unavailable.");
    }
  }

  function waitForFrameLoad(frame, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while loading the dashboard."));
      }, timeoutMs);

      function onLoad() {
        cleanup();
        resolve();
      }

      function onError() {
        cleanup();
        reject(new Error("The dashboard iframe failed to load."));
      }

      function cleanup() {
        clearTimeout(timeout);
        frame.removeEventListener("load", onLoad);
        frame.removeEventListener("error", onError);
      }

      frame.addEventListener("load", onLoad, { once: true });
      frame.addEventListener("error", onError, { once: true });
    });
  }

  function setLoading(isLoading, message) {
    loading.hidden = !isLoading;
    statusText.textContent = message;
  }

  function showError(message) {
    errorText.textContent = message;
    errorBanner.hidden = false;
  }

  function hideError() {
    errorBanner.hidden = true;
    errorText.textContent = "";
  }

  function getDashboardIdFromPath() {
    const match = window.location.pathname.match(/^\/(\d+)\/?$/);
    return match ? match[1] : DEFAULT_DASHBOARD_ID;
  }
})();
