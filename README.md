# Polymarket Sports Filter

Manifest V3 Chrome extension that filters Polymarket profile Positions and Activity rows by selected sports. The default filter is NBA only.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `polymarket-chrome`.
5. Visit a Polymarket profile URL such as `https://polymarket.com/@takumi-crypto-81`.

## Use

Open the extension popup and select one or more sports. The page updates through `chrome.storage.sync` without a reload. NBA is selected by default.

The popup also shows simple diagnostics for the active Polymarket profile tab:

- `Matching`: rendered rows that match the selected sport filter and are allowed to show.
- `Hidden`: rendered rows that were filtered out.
- `Batch`: profile rows the extension inspected in the current loaded Polymarket batch.

If NBA is selected and the page looks blank, the diagnostics explain whether the currently rendered Polymarket batch has no NBA rows. Use `Find next NBA row` to manually search deeper. That button scrolls in bounded steps and can click visible `Show more activity` or `Show more positions` controls up to a small limit; it never runs automatically.

Use `Show debug details` in the popup when you need to inspect what the extension classified. It prints the selected filter, current row counts, matching sample rows, and visible filtered samples from the active profile tab.

When all rendered rows are hidden, the page also shows a small bottom-right hint so a blank filtered view does not look broken.

Supported sports in the popup:

- NBA
- NFL
- MLB
- NHL
- Soccer
- Tennis
- Esports

The local classifier also recognizes crypto and politics keywords so examples like Bitcoin or election markets are hidden when only NBA is selected.

Short NBA team abbreviations are treated conservatively. A single repeated code in a non-NBA event slug is not enough to show a row as NBA; this avoids false positives such as La Liga `lal` slugs and NHL `min` slugs.

## How It Works

- Content script runs only on Polymarket profile routes: `https://polymarket.com/@*` and `https://polymarket.com/profile/*`.
- No network requests, API keys, or off-page scraping are used.
- Rows are classified from visible page text plus Polymarket event/category href paths using local keyword maps and team names.
- Profile list rows that Polymarket renders without event links, such as closed-position category rows and yield-only activity rows, are handled through conservative virtual-list row detection.
- SPA navigation, profile tab switches, sorting, search updates, lazy-loaded rows, and show-more inserts are handled with `MutationObserver`, History API hooks, `popstate`, and a lightweight URL poll.
- The extension fails open for page structure: it only hides row-like elements with known classifier keywords and leaves profile headers, tabs, search controls, footer, and unrelated sections alone.

### Polymarket Virtual Lists

Polymarket profile tabs use virtualized rows, especially on Activity and Positions. The extension filters only the rows Polymarket has rendered in the page; it does not fetch profile data from APIs or re-render an alternate table.

For virtualized rows, non-matching markets are hidden in place with `visibility: hidden` instead of being collapsed with `display: none`. This preserves Polymarket's row measurements and avoids the row-swapping, repeated loading, and janky behavior that happened when hidden rows changed the virtual list height.

Expected consequence: if the current Activity or Positions render batch has no NBA markets, the tab can look blank while NBA is selected. Scrolling lets Polymarket render deeper rows; matching NBA rows become visible when they enter the rendered range, while non-NBA rows stay hidden.

The manual find-next command exists for that case. It is user-triggered, capped at 18 scroll attempts, and capped at 3 show-more clicks. If no matching row appears inside that range, the popup reports that no NBA row was found in the searched range.

## Project Structure

```text
manifest.json            Chrome MV3 extension manifest
popup/                   Extension popup UI and storage controls
src/                     Content script and local sports classifier
tests/                   Classifier unit tests
scripts/                 Live Chrome QA and screenshot automation
README.md                Install, usage, and manual QA checklist
```

## Test

Run classifier tests:

```bash
npm test
```

Run live Chrome QA:

```bash
npm run qa:live
```

Run the deeper multi-profile QA matrix:

```bash
npm run qa:deep
```

Run the exact Takumi Closed Positions to Activity regression check:

```bash
npm run qa:sequence
```

Run the wallet Activity regression check. It uses `cookie.json` from the repo root when present; otherwise pass an exported Polymarket cookie JSON so Chrome opens as the logged-in profile before the script clicks "Show more activity":

```bash
$env:POLYMARKET_COOKIE_JSON="C:\path\to\cookies.json"; npm run qa:activity
```

For a public-session probe without cookies, set `PSF_ACTIVITY_ALLOW_ANONYMOUS=1`.

Open a visible local Chrome window with this unpacked extension loaded on the Demonren wallet profile:

```bash
npm run open:profile
```

Pass a different profile URL after `--` when needed. The launcher restores `.qa/polymarket-session.json` when present, otherwise it uses `cookie.json` from the repo root or `POLYMARKET_COOKIE_JSON`. It keeps Chrome alive until you press `Ctrl+C` in the terminal:

```bash
npm run open:profile -- "https://polymarket.com/@takumi-crypto-81"
```

Run the same launcher in check mode to print the content-script diagnostics without keeping Chrome open:

```bash
npm run open:profile -- --check
```

Run the check mode with the manual find-next command:

```bash
npm run open:profile -- "https://polymarket.com/@demonren?tab=activity" --check --find-next-check
```

Check mode also fails if NBA matching samples contain known non-NBA leakage terms such as `Barcelona`, `Avalanche`, `NHL`, or `La Liga`.

After logging in through the stable manual profile, save a reusable session bundle:

```bash
$env:PSF_OPEN_PROFILE_DIR=".qa\manual-polymarket-profile"; npm run save:session
```

The bundle is written to `.qa/polymarket-session.json` and includes cookies plus Polymarket browser storage. `npm run open:profile` automatically restores it when present; pass `-- --no-session` to ignore it.

Capture before/after screenshots for visual inspection:

```bash
npm run qa:screenshots
```

Live QA screenshots and reports are written to `.qa/`, which is intentionally ignored by git.

## Latest Demonren QA Snapshot

Round checked locally on May 14, 2026 with restored `.qa/polymarket-session.json`, NBA selected by default, and content-script diagnostics from `npm run open:profile -- "https://polymarket.com/@demonren?tab=activity" --check --find-next-check`:

- Activity initial diagnostics: 19 rendered rows, 0 matching NBA rows, 0 visible non-NBA rows.
- Manual find-next diagnostics: found `Timberwolves vs. Spurs` after 4 bounded scroll attempts and 0 show-more clicks.
- Positions initial diagnostics: 18 rendered rows, 0 matching NBA rows, blank-state hint visible.

The browser check confirmed the restored session was logged in and no non-NBA markets were visible under NBA-only filtering. Blank space can still appear because hidden virtual rows intentionally keep their measured height.

## Manual Test Checklist

- Load the unpacked extension in Chrome.
- Open `https://polymarket.com/@takumi-crypto-81` or another Polymarket profile page.
- Confirm the popup defaults to NBA selected.
- With NBA selected, confirm rows such as `Lakers vs. Thunder`, `Knicks vs. 76ers`, `Timberwolves vs. Cavaliers`, or other NBA markets remain visible.
- Confirm non-NBA rows such as `Chiefs vs. Eagles`, `Yankees vs. Dodgers`, Bitcoin markets, and election markets are hidden when NBA is the only selected sport.
- Select NBA and NFL in the popup and confirm both NBA and NFL rows are visible without reloading.
- Switch between Positions, Activity, Active, and Closed views and confirm filtering still applies.
- On `https://polymarket.com/@takumi-crypto-81`, open Positions, switch to Closed, and confirm esports/tennis rows are hidden with NBA-only selected; then switch to Activity and confirm yield-only rows are hidden while NBA trade rows remain.
- Use profile search, sorting controls, and show-more or lazy-loaded rows and confirm newly inserted rows are filtered.
- Navigate from one `https://polymarket.com/@...` profile to another inside the site and confirm filtering reapplies.
- Open a wallet profile route such as `https://polymarket.com/profile/0x...` and confirm filtering also applies after the site resolves the profile.
