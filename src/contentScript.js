(function runPolymarketSportsFilter() {
  const api = window.PolymarketSportsFilter;
  const stateApi = window.PolymarketFilterState;

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
  const FIND_NEXT_MAX_ATTEMPTS = 18;
  const FIND_NEXT_MAX_SHOW_MORE_CLICKS = 3;
  const FIND_NEXT_SCROLL_RATIO = 0.75;
  const FIND_NEXT_RENDER_WAIT_MS = 700;
  const FIND_NEXT_SHOW_MORE_WAIT_MS = 1800;
  const MESSAGE_GET_STATUS = "PSF_GET_STATUS";
  const MESSAGE_FIND_NEXT_MATCH = "PSF_FIND_NEXT_MATCH";
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
  let searchInProgress = false;
  let lastSearchResult = null;
  let latestStatus = createBaseStatus();
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

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getSelectedSportsLabel() {
    if (stateApi && typeof stateApi.formatSelectedSportsLabel === "function") {
      return stateApi.formatSelectedSportsLabel(selectedSports, api.SPORT_OPTIONS);
    }

    return selectedSports.join(", ").toUpperCase();
  }

  function createBaseStatus(overrides = {}) {
    const status = {
      hiddenRows: 0,
      hiddenVirtualRows: 0,
      isProfilePage: isProfilePage(),
      matchingRows: 0,
      matchingSamples: [],
      message: "",
      renderedRows: 0,
      search: lastSearchResult,
      selectedSports: selectedSports.slice(),
      selectedSportsLabel: getSelectedSportsLabel(),
      unknownRows: 0,
      updatedAt: new Date().toISOString(),
      url: window.location.href,
      visibleMatchingRows: 0,
      visibleNonMatchingRows: 0,
      visibleNonMatchingSamples: [],
      ...overrides,
    };

    status.message =
      status.message ||
      (stateApi && typeof stateApi.buildDiagnosticsMessage === "function"
        ? stateApi.buildDiagnosticsMessage(status, selectedSports, api.SPORT_OPTIONS)
        : "");

    return status;
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
    return cleanText(element.innerText || element.textContent);
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

  function isElementVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function getAbsoluteTop(element) {
    return getUsableRect(element).top + window.scrollY;
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
      return { categories: cached.categories, row, shouldHide: cached.shouldHide, text };
    }

    const categories = api.classifyMarketText(text);
    const shouldHide = api.shouldHideForSelectedSports(text, selectedSports);
    rowDecisionCache.set(row, { categories, selectedSportsKey, shouldHide, text });

    return { categories, row, shouldHide, text };
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

  function updateLatestStatus(overrides = {}) {
    latestStatus = createBaseStatus(overrides);
    return latestStatus;
  }

  function updateSearchResult(result) {
    lastSearchResult = result;
    latestStatus = {
      ...latestStatus,
      search: lastSearchResult,
      updatedAt: new Date().toISOString(),
    };
    return lastSearchResult;
  }

  function buildStatusFromDecisions(decisions) {
    const matchingDecisions = decisions.filter((decision) => !decision.shouldHide);
    const visibleNonMatchingDecisions = decisions.filter(
      (decision) => decision.shouldHide && isElementVisible(decision.row)
    );

    return updateLatestStatus({
      hiddenRows: decisions.length - matchingDecisions.length,
      hiddenVirtualRows: decisions.filter(
        (decision) => decision.shouldHide && decision.row.matches(VIRTUAL_ROW_SELECTOR)
      ).length,
      isProfilePage: true,
      matchingRows: matchingDecisions.length,
      matchingSamples: matchingDecisions.slice(0, 5).map((decision) => ({
        categories: decision.categories,
        text: cleanText(decision.text).slice(0, 220),
      })),
      renderedRows: decisions.length,
      unknownRows: decisions.filter((decision) => !decision.categories.length).length,
      visibleMatchingRows: decisions.filter(
        (decision) => !decision.shouldHide && isElementVisible(decision.row)
      ).length,
      visibleNonMatchingRows: visibleNonMatchingDecisions.length,
      visibleNonMatchingSamples: visibleNonMatchingDecisions.slice(0, 5).map((decision) => ({
        categories: decision.categories,
        text: cleanText(decision.text).slice(0, 220),
      })),
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
      updateLatestStatus({ isProfilePage: false });
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
    buildStatusFromDecisions(decisions);

    if (changedRows > 0) {
      scheduleSettlingFilters();
    }
  }

  function getFilterStatus() {
    applyFilters();
    return latestStatus;
  }

  function getRenderedMatchingRowsAfter(minTop) {
    const selectedSportsKey = getSelectedSportsKey();

    return collectCandidateRows()
      .map((row) => getRowDecision(row, selectedSportsKey))
      .filter((decision) => !decision.shouldHide && isElementVisible(decision.row))
      .map((decision) => ({
        decision,
        top: getAbsoluteTop(decision.row),
      }))
      .filter((entry) => entry.top >= minTop)
      .sort((left, right) => left.top - right.top);
  }

  function getSearchRowLabel() {
    const label = getSelectedSportsLabel();
    return selectedSports.length === 1 ? `${label} row` : "matching row";
  }

  function describeRow(row) {
    const firstLine = cleanText(getElementText(row)).slice(0, 90);
    return firstLine || getSearchRowLabel();
  }

  function isNearPageBottom() {
    const scrollBottom = window.scrollY + window.innerHeight;
    const documentHeight = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );

    return scrollBottom >= documentHeight - 24;
  }

  function clickVisibleShowMore() {
    const labels = new Set(["show more activity", "show more positions"]);
    const control = Array.from(document.querySelectorAll("button, a")).find((element) => {
      if (!isElementVisible(element)) {
        return false;
      }

      return labels.has(cleanText(element.textContent).toLowerCase());
    });

    if (!control) {
      return "";
    }

    const label = cleanText(control.textContent);
    control.click();
    return label;
  }

  async function findNextMatchingRow() {
    if (!isProfilePage()) {
      return {
        attempts: 0,
        message: "Open a supported Polymarket profile page to use the filter.",
        showMoreClicks: 0,
        status: "unsupported",
      };
    }

    if (searchInProgress) {
      return {
        attempts: 0,
        message: "Search already running.",
        showMoreClicks: 0,
        status: "running",
      };
    }

    searchInProgress = true;
    updateSearchResult({
      attempts: 0,
      message: `Searching for the next ${getSearchRowLabel()}...`,
      showMoreClicks: 0,
      status: "searching",
    });

    try {
      let attempts = 0;
      let showMoreClicks = 0;
      let minTop = window.scrollY + 8;
      const scrollAmount = Math.max(240, Math.floor(window.innerHeight * FIND_NEXT_SCROLL_RATIO));

      while (attempts <= FIND_NEXT_MAX_ATTEMPTS) {
        applyFilters();

        const match = getRenderedMatchingRowsAfter(minTop)[0];

        if (match) {
          match.decision.row.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
          await sleep(FIND_NEXT_RENDER_WAIT_MS);
          applyFilters();

          return updateSearchResult({
            attempts,
            message: `Found ${describeRow(match.decision.row)}.`,
            showMoreClicks,
            status: "found",
          });
        }

        if (attempts === FIND_NEXT_MAX_ATTEMPTS || isNearPageBottom()) {
          const showMoreLabel =
            showMoreClicks < FIND_NEXT_MAX_SHOW_MORE_CLICKS ? clickVisibleShowMore() : "";

          if (showMoreLabel) {
            showMoreClicks += 1;
            updateSearchResult({
              attempts,
              message: `${showMoreLabel} clicked. Searching loaded rows...`,
              showMoreClicks,
              status: "searching",
            });
            await sleep(FIND_NEXT_SHOW_MORE_WAIT_MS);
            minTop = Math.max(0, window.scrollY - 24);
            continue;
          }

          break;
        }

        const previousY = window.scrollY;
        window.scrollBy({ top: scrollAmount, left: 0, behavior: "smooth" });
        attempts += 1;
        await sleep(FIND_NEXT_RENDER_WAIT_MS);
        minTop = Math.max(previousY + 8, window.scrollY - 24);

        if (window.scrollY === previousY && isNearPageBottom()) {
          break;
        }
      }

      return updateSearchResult({
        attempts,
        message: `No ${getSearchRowLabel()} found in the searched range.`,
        showMoreClicks,
        status: "not_found",
      });
    } finally {
      searchInProgress = false;
    }
  }

  function installMessageListener() {
    if (!chrome.runtime || !chrome.runtime.onMessage) {
      return;
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== "object") {
        return false;
      }

      if (message.type === MESSAGE_GET_STATUS) {
        sendResponse({ ok: true, status: getFilterStatus() });
        return false;
      }

      if (message.type === MESSAGE_FIND_NEXT_MATCH) {
        findNextMatchingRow()
          .then((result) => sendResponse({ ok: true, result, status: getFilterStatus() }))
          .catch((error) =>
            sendResponse({
              error: error && error.message ? error.message : "Find next failed.",
              ok: false,
              status: getFilterStatus(),
            })
          );
        return true;
      }

      return false;
    });
  }

  function exposeRuntimeForQa() {
    window.PolymarketSportsFilterRuntime = {
      findNextMatchingRow,
      getStatus: getFilterStatus,
    };
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
  installMessageListener();
  installStorageListener();
  exposeRuntimeForQa();
})();
