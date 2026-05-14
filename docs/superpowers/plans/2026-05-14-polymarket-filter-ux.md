# Polymarket Filter UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add popup diagnostics, a manual Find next NBA row command, and classifier hardening for Polymarket profile filtering.

**Architecture:** Keep filtering inside the content script and keep the popup as the user control surface. Add one pure helper module for diagnostics text so the behavior can be tested without a browser.

**Tech Stack:** Manifest V3 Chrome extension, plain JavaScript, `chrome.storage.sync`, `chrome.tabs.sendMessage`, Node unit tests.

---

## File Structure

- Create `src/filterState.js`: pure diagnostics formatting helpers.
- Modify `manifest.json`: load `src/filterState.js` before `src/contentScript.js`, and add the active tab permission needed by the popup to message the current tab.
- Modify `popup/popup.html`: add diagnostics counters and a find-next button.
- Modify `popup/popup.css`: style the diagnostics panel and command button.
- Modify `popup/popup.js`: read diagnostics from the content script and send the manual find-next command.
- Modify `src/contentScript.js`: track filter stats, handle popup messages, expose a bounded manual search command, and show a small in-page hint when all rendered rows are hidden.
- Modify `src/sportClassifier.js`: add NBA abbreviations and additional real-world aliases.
- Modify `tests/classifier.test.js`: add classifier regression cases.
- Create `tests/filterState.test.js`: cover diagnostics text and labels.
- Modify `package.json`: run both test files.
- Modify `README.md`: document diagnostics and find-next behavior.

## Task 1: Add Tested Diagnostics Helpers

**Files:**
- Create: `src/filterState.js`
- Create: `tests/filterState.test.js`
- Modify: `package.json`

- [ ] Step 1: Write the failing helper tests.

```javascript
const assert = require("node:assert/strict");
const {
  buildDiagnosticsMessage,
  formatSelectedSportsLabel,
} = require("../src/filterState");

const sports = [
  { id: "nba", label: "NBA" },
  { id: "nfl", label: "NFL" },
];

assert.equal(formatSelectedSportsLabel(["nba"], sports), "NBA");
assert.equal(formatSelectedSportsLabel(["nba", "nfl"], sports), "NBA, NFL");

assert.equal(
  buildDiagnosticsMessage({ isProfilePage: false }, ["nba"], sports),
  "Open a supported Polymarket profile page to use the filter."
);

assert.equal(
  buildDiagnosticsMessage({ isProfilePage: true, renderedRows: 0 }, ["nba"], sports),
  "No profile rows are rendered yet."
);

assert.equal(
  buildDiagnosticsMessage({ isProfilePage: true, renderedRows: 23, matchingRows: 0, hiddenRows: 23 }, ["nba"], sports),
  "The current Polymarket batch has no NBA rows."
);

assert.equal(
  buildDiagnosticsMessage({ isProfilePage: true, renderedRows: 48, matchingRows: 4, hiddenRows: 44 }, ["nba"], sports),
  "Showing matching NBA rows from the current Polymarket batch."
);
```

- [ ] Step 2: Run the test and verify it fails because `src/filterState.js` does not exist.

Run: `node tests/filterState.test.js`

Expected: FAIL with `Cannot find module '../src/filterState'`.

- [ ] Step 3: Implement `src/filterState.js` as a UMD-style module like `src/sportClassifier.js`.

- [ ] Step 4: Update `package.json` test script to run classifier and filter state tests.

Run: `npm test`

Expected: both test files pass.

## Task 2: Harden Classifier Cases

**Files:**
- Modify: `src/sportClassifier.js`
- Modify: `tests/classifier.test.js`

- [ ] Step 1: Add failing classifier assertions for NBA abbreviations and non-NBA leakage.

Examples:

```javascript
assert.equal(matchesSelectedSports("/sports/nba/games BOS vs DAL: Game spread", ["nba"]), true);
assert.equal(matchesSelectedSports("NYK vs ATL", ["nba"]), true);
assert.equal(matchesSelectedSports("LoL: Invictus Gaming vs Bilibili Gaming", ["nba"]), false);
assert.equal(matchesSelectedSports("UFC 328: Yaroslav Amosov vs Joel Alvarez", ["nba"]), false);
assert.equal(matchesSelectedSports("/sports/nba/games Chicago Sky vs. Golden State Valkyries", ["nba"]), false);
assert.equal(matchesSelectedSports("/sports/nhl/games/min-vs-col Wild vs. Avalanche Wild", ["nba"]), false);
assert.equal(matchesSelectedSports("/event/lal-ala-bar-2026-05-13 Will Deportivo Alavés vs. FC Barcelona end in a draw?", ["nba"]), false);
assert.equal(matchesSelectedSports("LAL vs OKC", ["nba"]), true);
```

- [ ] Step 2: Run `npm test` and verify the new NBA abbreviation and false-positive cases fail before implementation.

- [ ] Step 3: Add the minimum aliases and keywords to `src/sportClassifier.js`.

- [ ] Step 4: Run `npm test` and verify all classifier tests pass.

## Task 3: Add Content Diagnostics and Messaging

**Files:**
- Modify: `manifest.json`
- Modify: `src/contentScript.js`

- [ ] Step 1: Load `src/filterState.js` before `src/contentScript.js` in `manifest.json`.

- [ ] Step 2: In `src/contentScript.js`, store the latest stats after every `applyFilters()` run.

Stats shape:

```javascript
{
  isProfilePage: true,
  selectedSports: ["nba"],
  renderedRows: 23,
  matchingRows: 0,
  visibleMatchingRows: 0,
  hiddenRows: 23,
  hiddenVirtualRows: 23,
  visibleNonMatchingRows: 0,
  unknownRows: 3,
  message: "The current Polymarket batch has no NBA rows."
}
```

- [ ] Step 3: Add a `chrome.runtime.onMessage` handler for:

```javascript
{ type: "PSF_GET_STATUS" }
{ type: "PSF_FIND_NEXT_MATCH" }
```

- [ ] Step 4: Expose `window.PolymarketSportsFilterRuntime.getStatus()` in the content script isolated world for QA scripts.

- [ ] Step 5: Run syntax checks.

Run:

```bash
node --check src\filterState.js
node --check src\contentScript.js
```

Expected: both exit 0.

## Task 4: Add Manual Find Next Search

**Files:**
- Modify: `src/contentScript.js`

- [ ] Step 1: Implement `findNextMatchingRow()` with fixed limits: no automatic start, no concurrent searches, at most 18 scroll attempts, at most 3 show-more clicks, and a short wait after each scroll or show-more click.

- [ ] Step 2: Return structured results:

```javascript
{ status: "found", message: "Found Cavaliers vs. Pistons", attempts: 3, showMoreClicks: 1 }
{ status: "not_found", message: "No NBA row found in the searched range.", attempts: 18, showMoreClicks: 3 }
{ status: "running", message: "Search already running.", attempts: 0, showMoreClicks: 0 }
```

- [ ] Step 3: Run `node --check src\contentScript.js`.

Expected: exit 0.

## Task 5: Add Popup Diagnostics UI

**Files:**
- Modify: `manifest.json`
- Modify: `popup/popup.html`
- Modify: `popup/popup.css`
- Modify: `popup/popup.js`

- [ ] Step 1: Add a diagnostics section with counters, explanation text, and a button.

- [ ] Step 2: In `popup.js`, query the active tab and send `PSF_GET_STATUS` every second while the popup is open.

- [ ] Step 3: Wire the button to send `PSF_FIND_NEXT_MATCH` and refresh diagnostics when the command finishes.

- [ ] Step 4: Gracefully handle unsupported pages and missing content scripts.

- [ ] Step 5: Run syntax checks.

Run:

```bash
node --check popup\popup.js
```

Expected: exit 0.

## Task 6: Documentation and Browser QA

**Files:**
- Modify: `README.md`

- [ ] Step 1: Document what diagnostics mean and how Find next NBA row works.

- [ ] Step 2: Run unit and syntax checks.

Run:

```bash
npm test
node --check src\contentScript.js
node --check popup\popup.js
```

Expected: all exit 0.

- [ ] Step 3: Run a browser QA pass on the Demonren profile with the unpacked extension and restored session.

Expected evidence:

- popup/content status reports `isProfilePage: true`.
- NBA-only diagnostics show zero visible known non-NBA rows.
- Find next returns `found` or `not_found` within the fixed attempt limit.
- No automatic scrolling occurs before the button command.

- [ ] Step 4: Commit the implementation.

```bash
git add manifest.json package.json README.md popup src tests docs
git commit -m "Add filter diagnostics and manual NBA search"
```
