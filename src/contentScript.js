(function runPolymarketSportsFilter() {
  const api = window.PolymarketSportsFilter;

  if (!api) {
    return;
  }

  const STORAGE_KEY = "selectedSports";
  const HIDDEN_CLASS = "psf-hidden-row";
  const MAX_ROW_TEXT_LENGTH = 900;
  const MAX_ROW_HEIGHT = 340;
  const EVENT_MARKET_LINK_SELECTOR = "a[href*='/event/'], a[href*='/market/']";
  const CATEGORY_LINK_SELECTOR = "a[href*='/sports/'], a[href*='/esports/']";
  const FILTERABLE_LINK_SELECTOR = `${EVENT_MARKET_LINK_SELECTOR}, ${CATEGORY_LINK_SELECTOR}`;
  const VIRTUAL_ROW_SELECTOR = "[data-index][data-item-index], [data-item-index][data-known-size]";
  const POLYMARKET_CLASSIFICATION_PATH = /\/(event|market|sports|esports)\//i;
  const PROFILE_LIST_TEXT_PATTERN =
    /\b(won|lost|bought|sold|redeemed|yield|shares?|holdings yield|ago|at\s+\d+(?:\.\d+)?\s*¢|\$[\d,.]+|\d+(?:\.\d+)?\s*¢)\b/i;

  let selectedSports = api.DEFAULT_SELECTED_SPORTS.slice();
  let scheduled = false;
  let lastUrl = window.location.href;
  let observer = null;

  function isProfilePage() {
    return (
      window.location.hostname === "polymarket.com" &&
      (/^\/@[^/]+/.test(window.location.pathname) || /^\/profile\/[^/]+/.test(window.location.pathname))
    );
  }

  function injectStyles() {
    if (document.getElementById("psf-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "psf-style";
    style.textContent = `.${HIDDEN_CLASS}{display:none!important;}`;
    document.documentElement.appendChild(style);
  }

  function readSettings() {
    if (!chrome.storage || !chrome.storage.sync) {
      selectedSports = api.DEFAULT_SELECTED_SPORTS.slice();
      scheduleFilter();
      return;
    }

    chrome.storage.sync.get({ [STORAGE_KEY]: api.DEFAULT_SELECTED_SPORTS }, (items) => {
      selectedSports = api.normalizeSelectedSports(items[STORAGE_KEY]);
      scheduleFilter();
    });
  }

  function scheduleFilter() {
    if (scheduled) {
      return;
    }

    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      applyFilters();
    });
  }

  function getMainRoot() {
    return document.querySelector("main") || document.body;
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getElementText(element) {
    return cleanText(element.textContent);
  }

  function isIgnoredElement(element) {
    if (!(element instanceof HTMLElement)) {
      return true;
    }

    if (
      element.matches(
        [
          "html",
          "body",
          "main",
          "script",
          "style",
          "svg",
          "path",
          "input",
          "textarea",
          "select",
          "option",
          "button",
          "[role='tab']",
          "[role='tablist']",
          "[contenteditable='true']",
        ].join(",")
      )
    ) {
      return true;
    }

    return Boolean(element.closest("header, footer, nav, form, [role='navigation'], [aria-label*='search' i]"));
  }

  function hasMultipleMarketLinks(element, current) {
    const links = Array.from(element.querySelectorAll(FILTERABLE_LINK_SELECTOR));

    if (links.length <= 1) {
      return false;
    }

    return !links.every((link) => link === current || current.contains(link));
  }

  function hasSearchOrTabs(element) {
    return Boolean(
      element.querySelector(
        "input, textarea, select, form, [role='tab'], [role='tablist'], [aria-label*='search' i]"
      )
    );
  }

  function getUsableRect(element) {
    if (typeof element.getBoundingClientRect !== "function") {
      return { height: 0, width: 0 };
    }

    return element.getBoundingClientRect();
  }

  function hasMarketLink(element) {
    return Boolean(
      element.matches(FILTERABLE_LINK_SELECTOR) || element.querySelector(FILTERABLE_LINK_SELECTOR)
    );
  }

  function isEventMarketLink(element) {
    return element.matches(EVENT_MARKET_LINK_SELECTOR);
  }

  function looksLikeProfileListRow(element) {
    return PROFILE_LIST_TEXT_PATTERN.test(getElementText(element));
  }

  function canBeMarketRowShape(element) {
    if (isIgnoredElement(element)) {
      return false;
    }

    const text = getElementText(element);

    if (!text || text.length > MAX_ROW_TEXT_LENGTH) {
      return false;
    }

    if (hasSearchOrTabs(element)) {
      return false;
    }

    const rect = getUsableRect(element);

    if (rect.height && rect.height > MAX_ROW_HEIGHT) {
      return false;
    }

    return true;
  }

  function getVirtualListRow(element, root) {
    const row = element.closest(VIRTUAL_ROW_SELECTOR);

    if (!row || row === root || !root.contains(row)) {
      return null;
    }

    return row;
  }

  function isFilterableVirtualRow(element, root) {
    return (
      element.matches(VIRTUAL_ROW_SELECTOR) &&
      element !== root &&
      root.contains(element) &&
      canBeMarketRowShape(element) &&
      looksLikeProfileListRow(element)
    );
  }

  function resolveMarketLinkRow(element, root) {
    const virtualRow = getVirtualListRow(element, root);

    if (virtualRow && isFilterableVirtualRow(virtualRow, root)) {
      return virtualRow;
    }

    if (isEventMarketLink(element)) {
      return resolveRowElement(element, root);
    }

    return null;
  }

  function resolveRowElement(element, root) {
    let current = element;
    let currentText = getElementText(current);
    let best = current;

    for (let depth = 0; depth < 6; depth += 1) {
      const parent = current.parentElement;

      if (!parent || parent === root || parent === document.body || parent === document.documentElement) {
        break;
      }

      if (isIgnoredElement(parent) || hasSearchOrTabs(parent)) {
        break;
      }

      const parentText = getElementText(parent);

      if (!parentText || parentText.length > MAX_ROW_TEXT_LENGTH) {
        break;
      }

      if (hasMultipleMarketLinks(parent, current)) {
        break;
      }

      if (parentText.length > currentText.length * 2 + 320) {
        break;
      }

      const rect = getUsableRect(parent);

      if (rect.height && rect.height > MAX_ROW_HEIGHT) {
        break;
      }

      best = parent;
      current = parent;
      currentText = parentText;
    }

    return best;
  }

  function collectCandidateRows() {
    const root = getMainRoot();
    const rows = new Set();

    root.querySelectorAll(FILTERABLE_LINK_SELECTOR).forEach((element) => {
      if (!canBeMarketRowShape(element)) {
        return;
      }

      const row = resolveMarketLinkRow(element, root);

      if (row && canBeMarketRowShape(row)) {
        rows.add(row);
      }
    });

    root.querySelectorAll(VIRTUAL_ROW_SELECTOR).forEach((row) => {
      if (isFilterableVirtualRow(row, root)) {
        rows.add(row);
      }
    });

    return Array.from(rows);
  }

  function getLinkClassificationText(link) {
    if (!link.href) {
      return "";
    }

    try {
      const url = new URL(link.href, window.location.href);

      if (url.hostname !== "polymarket.com" || !POLYMARKET_CLASSIFICATION_PATH.test(url.pathname)) {
        return "";
      }

      return decodeURIComponent(url.pathname).replace(/[/_-]+/g, " ");
    } catch (error) {
      return "";
    }
  }

  function getClassificationText(element) {
    const linkText = Array.from(element.querySelectorAll("a[href]"))
      .map(getLinkClassificationText)
      .filter(Boolean)
      .join(" ");

    return cleanText(`${getElementText(element)} ${linkText}`);
  }

  function setHidden(element, shouldHide) {
    element.classList.toggle(HIDDEN_CLASS, shouldHide);
    element.dataset.psfFiltered = shouldHide ? "hidden" : "shown";
  }

  function revealAllFilteredRows() {
    document.querySelectorAll(`.${HIDDEN_CLASS}, [data-psf-filtered]`).forEach((element) => {
      element.classList.remove(HIDDEN_CLASS);
      delete element.dataset.psfFiltered;
    });
  }

  function applyFilters() {
    if (!isProfilePage()) {
      revealAllFilteredRows();
      return;
    }

    const rows = collectCandidateRows();
    const activeRows = new Set(rows);

    rows.forEach((row) => {
      const text = getClassificationText(row);
      setHidden(row, !api.matchesSelectedSports(text, selectedSports));
    });

    document.querySelectorAll("[data-psf-filtered]").forEach((element) => {
      if (!activeRows.has(element)) {
        setHidden(element, false);
      }
    });
  }

  function installMutationObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
      if (
        mutations.some(
          (mutation) =>
            mutation.type === "childList" ||
            mutation.type === "characterData" ||
            (mutation.type === "attributes" && mutation.attributeName === "href")
        )
      ) {
        scheduleFilter();
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["href"],
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  function handleUrlChange() {
    if (window.location.href === lastUrl) {
      return;
    }

    lastUrl = window.location.href;
    revealAllFilteredRows();
    scheduleFilter();
  }

  function installUrlWatcher() {
    ["pushState", "replaceState"].forEach((method) => {
      const original = window.history[method];

      window.history[method] = function patchedHistoryMethod() {
        const result = original.apply(this, arguments);
        window.setTimeout(handleUrlChange, 0);
        return result;
      };
    });

    window.addEventListener("popstate", () => window.setTimeout(handleUrlChange, 0));
    window.setInterval(handleUrlChange, 1000);
  }

  function installStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || !changes[STORAGE_KEY]) {
        return;
      }

      selectedSports = api.normalizeSelectedSports(changes[STORAGE_KEY].newValue);
      scheduleFilter();
    });
  }

  injectStyles();
  readSettings();
  installMutationObserver();
  installUrlWatcher();
  installStorageListener();
})();
