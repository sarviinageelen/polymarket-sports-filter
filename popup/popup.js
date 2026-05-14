(function runPopup() {
  const api = window.PolymarketSportsFilter;
  const stateApi = window.PolymarketFilterState;
  const STORAGE_KEY = "selectedSports";
  const MESSAGE_GET_STATUS = "PSF_GET_STATUS";
  const MESSAGE_FIND_NEXT_MATCH = "PSF_FIND_NEXT_MATCH";
  const REFRESH_INTERVAL_MS = 1000;

  const optionsRoot = document.getElementById("sportsOptions");
  const status = document.getElementById("status");
  const selectedSportsLabel = document.getElementById("selectedSportsLabel");
  const matchingRows = document.getElementById("matchingRows");
  const hiddenRows = document.getElementById("hiddenRows");
  const renderedRows = document.getElementById("renderedRows");
  const diagnosticsMessage = document.getElementById("diagnosticsMessage");
  const searchMessage = document.getElementById("searchMessage");
  const findNextButton = document.getElementById("findNextButton");

  if (!api || !stateApi || !optionsRoot) {
    return;
  }

  function setStatus(message) {
    if (!status) {
      return;
    }

    status.textContent = message;
  }

  function getCheckedSports() {
    return Array.from(optionsRoot.querySelectorAll("input[type='checkbox']:checked")).map(
      (input) => input.value
    );
  }

  function getCurrentSportsLabel() {
    return stateApi.formatSelectedSportsLabel(getCheckedSports(), api.SPORT_OPTIONS);
  }

  function getFindNextLabel(selectedLabel, visibleMatchingRows) {
    const selectedCount = getCheckedSports().length;

    if (selectedCount !== 1) {
      return visibleMatchingRows > 0 ? "Find another matching row" : "Find next matching row";
    }

    return visibleMatchingRows > 0
      ? `Find another ${selectedLabel} row`
      : `Find next ${selectedLabel} row`;
  }

  function setCounter(element, value) {
    if (!element) {
      return;
    }

    element.textContent =
      value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
        ? String(value)
        : "-";
  }

  function setFindNextEnabled(enabled) {
    if (!findNextButton) {
      return;
    }

    findNextButton.disabled = !enabled;
  }

  function renderUnavailable(message) {
    if (selectedSportsLabel) {
      selectedSportsLabel.textContent = getCurrentSportsLabel();
    }

    setCounter(matchingRows, null);
    setCounter(hiddenRows, null);
    setCounter(renderedRows, null);

    if (diagnosticsMessage) {
      diagnosticsMessage.textContent = message;
    }

    if (searchMessage) {
      searchMessage.textContent = "";
    }

    setFindNextEnabled(false);
  }

  function renderDiagnostics(pageStatus) {
    const snapshot = pageStatus || {};
    const selectedLabel = snapshot.selectedSportsLabel || getCurrentSportsLabel();

    if (selectedSportsLabel) {
      selectedSportsLabel.textContent = selectedLabel;
    }

    setCounter(matchingRows, snapshot.visibleMatchingRows ?? snapshot.matchingRows);
    setCounter(hiddenRows, snapshot.hiddenRows);
    setCounter(renderedRows, snapshot.renderedRows);

    if (diagnosticsMessage) {
      diagnosticsMessage.textContent =
        snapshot.message ||
        stateApi.buildDiagnosticsMessage(snapshot, snapshot.selectedSports || getCheckedSports(), api.SPORT_OPTIONS);
    }

    if (searchMessage) {
      searchMessage.textContent = snapshot.search && snapshot.search.message ? snapshot.search.message : "";
    }

    if (findNextButton) {
      findNextButton.textContent = getFindNextLabel(selectedLabel, Number(snapshot.visibleMatchingRows || 0));
    }

    setFindNextEnabled(Boolean(snapshot.isProfilePage));
  }

  function queryActiveTab() {
    return new Promise((resolve, reject) => {
      if (!chrome.tabs || !chrome.tabs.query) {
        reject(new Error("Chrome tabs access is unavailable."));
        return;
      }

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  async function sendActiveTabMessage(message) {
    const tab = await queryActiveTab();

    if (!tab || !tab.id) {
      throw new Error("No active tab found.");
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        if (!response || response.ok === false) {
          reject(new Error(response && response.error ? response.error : "The page filter did not respond."));
          return;
        }

        resolve(response);
      });
    });
  }

  async function refreshPageStatus() {
    try {
      const response = await sendActiveTabMessage({ type: MESSAGE_GET_STATUS });
      renderDiagnostics(response.status);
    } catch (error) {
      renderUnavailable("Open a supported Polymarket profile page to use the filter.");
    }
  }

  async function findNextMatch() {
    setFindNextEnabled(false);

    if (searchMessage) {
      searchMessage.textContent = `Searching for the next ${getCurrentSportsLabel()} row...`;
    }

    try {
      const response = await sendActiveTabMessage({ type: MESSAGE_FIND_NEXT_MATCH });
      renderDiagnostics(response.status);

      if (searchMessage && response.result && response.result.message) {
        searchMessage.textContent = response.result.message;
      }
    } catch (error) {
      if (searchMessage) {
        searchMessage.textContent = error.message || "Find next failed.";
      }
    } finally {
      await refreshPageStatus();
    }
  }

  function saveSelection() {
    const selectedSports = getCheckedSports();

    if (!selectedSports.length) {
      chrome.storage.sync.set({ [STORAGE_KEY]: api.DEFAULT_SELECTED_SPORTS }, () => {
        renderOptions(api.DEFAULT_SELECTED_SPORTS);
        setStatus("NBA restored.");
        refreshPageStatus();
      });
      return;
    }

    chrome.storage.sync.set({ [STORAGE_KEY]: selectedSports }, () => {
      setStatus("Updated.");
      refreshPageStatus();
    });
  }

  function renderOptions(selectedSports) {
    const selected = new Set(api.normalizeSelectedSports(selectedSports));

    optionsRoot.replaceChildren(
      ...api.SPORT_OPTIONS.map((option) => {
        const label = document.createElement("label");
        label.className = "option";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = option.id;
        checkbox.checked = selected.has(option.id);
        checkbox.addEventListener("change", saveSelection);

        const text = document.createElement("span");
        text.textContent = option.label;

        label.append(checkbox, text);
        return label;
      })
    );

    if (selectedSportsLabel) {
      selectedSportsLabel.textContent = getCurrentSportsLabel();
    }
  }

  if (findNextButton) {
    findNextButton.addEventListener("click", findNextMatch);
  }

  chrome.storage.sync.get({ [STORAGE_KEY]: api.DEFAULT_SELECTED_SPORTS }, (items) => {
    renderOptions(items[STORAGE_KEY]);
    setStatus("");
    refreshPageStatus();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[STORAGE_KEY]) {
      return;
    }

    renderOptions(changes[STORAGE_KEY].newValue);
    refreshPageStatus();
  });

  window.setInterval(refreshPageStatus, REFRESH_INTERVAL_MS);
})();
