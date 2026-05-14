# Polymarket Filter UX Design

## Goal

Make NBA-only filtering easier to understand and use on Polymarket profile pages without replacing Polymarket's UI or fetching/re-rendering profile activity from APIs.

## Problem

Polymarket profile pages use virtualized lists. The page renders only a slice of Activity or Positions rows at a time. When NBA is selected, the extension can correctly hide every currently rendered row and the page can look blank. To a normal user, that blank page looks like a bug because there is no explanation.

The previous auto-search behavior made the page feel janky because it changed scroll position and row visibility while Polymarket was also measuring virtual rows. The next version must keep the filter stable and make deeper searching a manual action.

## Scope

This version includes three improvements:

1. Popup diagnostics that explain what the extension filtered on the current Polymarket profile tab.
2. A manual "Find next NBA row" action that scrolls carefully until a matching rendered row is found or a fixed search limit is reached.
3. Classifier hardening using real Polymarket examples, including conservative NBA abbreviations plus WNBA, NHL, UFC, and esports terms that should not leak through NBA-only filtering.

This version does not fetch Polymarket APIs, place trades, modify wallet state, or render a replacement activity table.

## User Experience

The popup remains the main control surface. It keeps the existing sport checkboxes and adds a compact diagnostics area:

```text
Selected: NBA
Visible matching rows: 0
Rows hidden: 23

The current Polymarket batch has no NBA rows.

[Find next NBA row]
```

If matching rows are visible:

```text
Selected: NBA
Visible matching rows: 4
Rows hidden: 44

Showing matching rows from the current Polymarket batch.
```

If the active tab is not a supported Polymarket profile route, the popup explains that the user should open a Polymarket profile page.

When all currently rendered rows are hidden, the content script also shows a small bottom-right page hint. This hint is intentionally short and points users back to the extension popup for details.

## Architecture

`src/contentScript.js` stays responsible for page interaction. It filters rows, records the latest row counts, exposes a status snapshot, and handles the manual find-next command.

`popup/popup.js` stays responsible for user controls. It reads and writes selected sports, asks the content script for the latest diagnostics, and sends the manual find-next command.

`src/filterState.js` is a new small pure helper module. It formats selected sport labels, turns numeric row stats into plain-English explanations, and gives tests a stable place to verify diagnostics behavior without needing a browser.

`src/sportClassifier.js` remains the local classifier. It receives more aliases and regression examples, but still uses local text and URL hints only.

Short NBA abbreviations are conservative: one repeated abbreviation in a non-NBA slug is not enough to classify a row as NBA. Abbreviation-only classification requires at least two distinct NBA abbreviations in a matchup-like context.

## Manual Find Next Behavior

The find-next command is intentionally user-triggered. It should not run automatically when a page looks blank.

When clicked, the content script:

1. Checks whether a matching row already exists below the current scroll position.
2. If found, scrolls that row into view and stops.
3. Otherwise scrolls down by a controlled amount.
4. Waits briefly for Polymarket to render new rows.
5. Clicks a visible `Show more activity` or `Show more positions` control when it reaches the bottom, with a small fixed click limit.
6. Re-applies the filter and repeats.
7. Stops after a fixed attempt limit, a fixed show-more limit, or when no more rows can be loaded.

The command returns a status message such as `Found Cavaliers vs. Pistons` or `No NBA row found in the searched range`.

## Error Handling

If the content script is not available, the popup shows that the user should refresh the Polymarket tab or open a supported profile page.

If a search is already running, a second click does not start another search. The popup shows the current search state.

If no match is found, the page stays at the last searched position and the diagnostics explain how many rows were checked.

## Testing

Unit tests cover:

- NBA abbreviations and real NBA market examples.
- WNBA, NHL, UFC, and esports examples that must be hidden under NBA-only filtering.
- Diagnostics explanation text for blank, matching, unsupported, and idle states.

Browser checks cover:

- Popup/content messaging works on a Polymarket profile page.
- Diagnostics report zero visible non-NBA rows under NBA-only filtering.
- Manual find-next completes without automatic background scrolling.

## Acceptance Criteria

- A blank Activity or Positions view has a plain-English explanation in the popup.
- A blank Activity or Positions view has a small in-page hint so it does not look like the page broke.
- The user can manually search deeper for the next NBA row.
- The search has fixed limits and does not run unless the user clicks the button.
- The search can use Polymarket's own show-more controls, but only inside the manual command and only within the fixed limit.
- NBA-only filtering does not show known non-NBA rows.
- Real LoL/LPL and other esports examples classify as esports, not NBA.
- WNBA rows such as `Chicago Sky vs. Golden State Valkyries` and NHL rows such as `Wild vs. Avalanche` stay hidden under NBA-only filtering.
- Soccer rows with La Liga-style `lal` slugs, such as `Deportivo Alavés vs. FC Barcelona`, stay hidden under NBA-only filtering.
- Tests and syntax checks pass.
