(function runPolymarketSportsFilter() {
  const api = window.PolymarketSportsFilter;

  if (!api) {
    return;
  }

  const STORAGE_KEY = "selectedSports";
  const HIDDEN_CLASS = "psf-hidden-row";
  const HIDDEN_VIRTUAL_CLASS = "psf-hidden-virtual-row";
  const MAX_ROW_TEXT_LENGTH = 900;
  const MAX_ROW_HEIGHT = 340;
  const MUTATION_FILTER_DELAY_MS = 120;
  const BACKGROUND_FILTER_INTERVAL_MS = 1000;
  const SETTLE_FILTER_DELAY_MS = 180;
  const SETTLE_FILTER_PASSES = 20;
  const EVENT_MARKET_LINK_SELECTOR = "a[href*='/event/'], a[href*='/market/']";
  const CATEGORY_LINK_SELECTOR = "a[href*='/sports/'], a[href*='/esports/']";
  const FILTERABLE_LINK_SELECTOR = `${EVENT_MARKET_LINK_SELECTOR}, ${CATEGORY_LINK_SELECTOR}`;
  const VIRTUAL_ROW_SELECTOR = "[data-index][data-item-index], [data-item-index][data-known-size]";
  const FILTERABLE_CONTENT_SELECTOR = `${FILTERABLE_LINK_SELECTOR}, ${VIRTUAL_ROW_SELECTOR}, [data-psf-filtered]`;
  const POLYMARKET_CLASSIFICATION_PATH = /\/(event|market|sports|esports)\//i;
  const PROFILE_LIST_TEXT_PATTERN =
    /\b(won|lost|bought|sold|redeemed|yield|shares?|holdings yield|ago|at\s+\d+(?:\.\d+)?\s*¢|\$[\d,.]+|\d+(?:\.\d+)?\s*¢)\b/i;

  let selectedSports = api.DEFAULT_SELECTED_SPORTS.slice();
  let scheduled = false;
  let filterTimer = 0;
  let settleTimer = 0;
  let settlePassesRemaining = 0;
  let lastUrl = window.location.href;
  let observer = null;
  let rowDecisionCache = new WeakMap();
  const filteredRows = new Set();

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
    style.textContent = `.${HIDDEN_CLASS}{display:none!important;}.${HIDDEN_VIRTUAL_CLASS}{visibility:hidden!important;pointer-events:none!important;}`;
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

  function runScheduledFilter() {
    filterTimer = 0;

    if (scheduled) {
      return;
    }

    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      applyFilters();
    });
  }

  function scheduleFilter(delayMs = 0) {
    if (scheduled) {
      return;
    }

    if (filterTimer) {
      if (delayMs > 0) {
        return;
      }

      window.clearTimeout(filterTimer);
      filterTimer = 0;
    }

    if (delayMs > 0) {
      filterTimer = window.setTimeout(runScheduledFilter, delayMs);
      return;
    }

    runScheduledFilter();
  }

  function runSettlingFilter() {
    settleTimer = 0;

    if (settlePassesRemaining <= 0) {
      return;
    }

    settlePassesRemaining -= 1;
    scheduleFilter();

    if (settlePassesRemaining > 0) {
      settleTimer = window.setTimeout(runSettlingFilter, SETTLE_FILTER_DELAY_MS);
    }
  }

  function scheduleSettlingFilters() {
    settlePassesRemaining = Math.max(settlePassesRemaining, SETTLE_FILTER_PASSES);

    if (!settleTimer) {
      settleTimer = window.setTimeout(runSettlingFilter, SETTLE_FILTER_DELAY_MS);
    }
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

    if (element.matches(FILTERABLE_LINK_SELECTOR)) {
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

  function getSelectedSportsKey() {
    return selectedSports.join(",");
  }

  function getRowDecision(row, selectedSportsKey) {
    const text = getClassificationText(row);
    const cached = rowDecisionCache.get(row);

    if (cached && cached.text === text && cached.selectedSportsKey === selectedSportsKey) {
      return { row, shouldHide: cached.shouldHide };
    }

    const shouldHide = api.shouldHideForSelectedSports(text, selectedSports);
    rowDecisionCache.set(row, { selectedSportsKey, shouldHide, text });

    return { row, shouldHide };
  }

  function clearFilteredElement(element) {
    element.classList.remove(HIDDEN_CLASS);
    element.classList.remove(HIDDEN_VIRTUAL_CLASS);
    delete element.dataset.psfFiltered;
    filteredRows.delete(element);
    rowDecisionCache.delete(element);
  }

  function setHidden(element, shouldHide) {
    const nextState = shouldHide ? "hidden" : "shown";
    const hiddenClass = element.matches(VIRTUAL_ROW_SELECTOR) ? HIDDEN_VIRTUAL_CLASS : HIDDEN_CLASS;
    const otherHiddenClass = hiddenClass === HIDDEN_CLASS ? HIDDEN_VIRTUAL_CLASS : HIDDEN_CLASS;
    const alreadyHidden = element.classList.contains(hiddenClass);

    if (element.dataset.psfFiltered === nextState && alreadyHidden === shouldHide) {
      return false;
    }

    element.classList.remove(otherHiddenClass);
    element.classList.toggle(hiddenClass, shouldHide);
    element.dataset.psfFiltered = nextState;
    filteredRows.add(element);
    return true;
  }

  function revealAllFilteredRows() {
    document.querySelectorAll(`.${HIDDEN_CLASS}, .${HIDDEN_VIRTUAL_CLASS}, [data-psf-filtered]`).forEach((element) => {
      clearFilteredElement(element);
    });
    filteredRows.forEach((element) => {
      clearFilteredElement(element);
    });
    rowDecisionCache = new WeakMap();
  }

  function clearStaleFilteredRows(activeRows) {
    filteredRows.forEach((element) => {
      if (!element.isConnected || !activeRows.has(element)) {
        clearFilteredElement(element);
      }
    });
  }

  function applyFilters() {
    if (!isProfilePage()) {
      settlePassesRemaining = 0;
      if (settleTimer) {
        window.clearTimeout(settleTimer);
        settleTimer = 0;
      }
      revealAllFilteredRows();
      return;
    }

    const rows = collectCandidateRows();
    const activeRows = new Set(rows);
    const selectedSportsKey = getSelectedSportsKey();
    const decisions = rows.map((row) => getRowDecision(row, selectedSportsKey));

    const changedRows = decisions.reduce(
      (count, decision) => count + (setHidden(decision.row, decision.shouldHide) ? 1 : 0),
      0
    );

    clearStaleFilteredRows(activeRows);

    if (changedRows > 0) {
      scheduleSettlingFilters();
    }
  }

  function getMutationElement(node) {
    if (node instanceof Element) {
      return node;
    }

    return node && node.parentElement ? node.parentElement : null;
  }

  function containsFilterableContent(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    return Boolean(
      element.matches(FILTERABLE_CONTENT_SELECTOR) ||
        element.closest(FILTERABLE_CONTENT_SELECTOR) ||
        element.querySelector(FILTERABLE_CONTENT_SELECTOR)
    );
  }

  function mutationCouldAffectRows(mutation, root) {
    const target = getMutationElement(mutation.target);

    if (!target) {
      return false;
    }

    const touchesRoot = root.contains(target) || target.contains(root);

    if (!touchesRoot) {
      return false;
    }

    if (mutation.type === "childList") {
      return true;
    }

    if (mutation.type === "attributes") {
      return (
        (mutation.attributeName === "href" ||
          mutation.attributeName === "class" ||
          mutation.attributeName === "data-psf-filtered") &&
        containsFilterableContent(target)
      );
    }

    if (mutation.type === "characterData") {
      return containsFilterableContent(target);
    }

    return false;
  }

  function shouldScheduleForMutations(mutations) {
    const root = getMainRoot();

    return mutations.some((mutation) => mutationCouldAffectRows(mutation, root));
  }

  function installMutationObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
      if (shouldScheduleForMutations(mutations)) {
        scheduleFilter(MUTATION_FILTER_DELAY_MS);
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["href", "class", "data-psf-filtered"],
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

  function installBackgroundFilter() {
    window.setInterval(() => {
      if (isProfilePage()) {
        scheduleFilter(MUTATION_FILTER_DELAY_MS);
      }
    }, BACKGROUND_FILTER_INTERVAL_MS);
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
  installBackgroundFilter();
  installStorageListener();
})();
