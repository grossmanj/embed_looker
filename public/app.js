(() => {
  const DEFAULT_DASHBOARD_ID = "1327";

  const iframe = document.getElementById("dashboard-frame");
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");
  const errorOverlay = document.getElementById("error-overlay");
  const errorText = document.getElementById("error-text");
  const retryButton = document.getElementById("retry-btn");

  iframe.addEventListener("load", () => {
    hideError();
    setLoading(false);
  });

  retryButton.addEventListener("click", () => {
    loadDashboard();
  });

  loadDashboard();

  async function loadDashboard() {
    const dashboardId = getDashboardIdFromPath();
    setLoading(true, "Requesting secure dashboard URL...");
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

      setLoading(true, "Loading dashboard...");
      iframe.src = payload.url;
      iframe.hidden = false;
      setLoading(false);
    } catch (error) {
      showError(
        error.message ||
          "Unable to load the dashboard right now. Please try again."
      );
      setLoading(false);
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
})();
