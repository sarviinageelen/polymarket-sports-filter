(function initFilterState(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PolymarketFilterState = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createFilterStateApi() {
  function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function formatSelectedSportsLabel(selectedSports, sportOptions) {
    const selected = new Set(normalizeArray(selectedSports));
    const labels = normalizeArray(sportOptions)
      .filter((option) => selected.has(option.id))
      .map((option) => option.label);

    return labels.length ? labels.join(", ") : "selected sports";
  }

  function buildDiagnosticsMessage(stats, selectedSports, sportOptions) {
    const safeStats = stats || {};
    const selectedLabel = formatSelectedSportsLabel(selectedSports, sportOptions);

    if (!safeStats.isProfilePage) {
      return "Open a supported Polymarket profile page to use the filter.";
    }

    if (!safeStats.renderedRows) {
      return "No profile rows are rendered yet.";
    }

    if (!safeStats.matchingRows) {
      return `The current loaded batch has no ${selectedLabel} rows.`;
    }

    return `Showing matching ${selectedLabel} rows from the current loaded batch.`;
  }

  return {
    buildDiagnosticsMessage,
    formatSelectedSportsLabel,
  };
});
