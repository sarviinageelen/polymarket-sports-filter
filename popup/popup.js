(function runPopup() {
  const api = window.PolymarketSportsFilter;
  const STORAGE_KEY = "selectedSports";
  const optionsRoot = document.getElementById("sportsOptions");
  const status = document.getElementById("status");

  if (!api || !optionsRoot) {
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

  function saveSelection() {
    const selectedSports = getCheckedSports();

    if (!selectedSports.length) {
      chrome.storage.sync.set({ [STORAGE_KEY]: api.DEFAULT_SELECTED_SPORTS }, () => {
        renderOptions(api.DEFAULT_SELECTED_SPORTS);
        setStatus("NBA restored.");
      });
      return;
    }

    chrome.storage.sync.set({ [STORAGE_KEY]: selectedSports }, () => {
      setStatus("Updated.");
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
  }

  chrome.storage.sync.get({ [STORAGE_KEY]: api.DEFAULT_SELECTED_SPORTS }, (items) => {
    renderOptions(items[STORAGE_KEY]);
    setStatus("");
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[STORAGE_KEY]) {
      return;
    }

    renderOptions(changes[STORAGE_KEY].newValue);
  });
})();
