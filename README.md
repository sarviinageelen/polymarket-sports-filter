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

Supported sports in the popup:

- NBA
- NFL
- MLB
- NHL
- Soccer
- Tennis
- Esports

The local classifier also recognizes crypto and politics keywords so examples like Bitcoin or election markets are hidden when only NBA is selected.

## How It Works

- Content script runs only on Polymarket profile routes: `https://polymarket.com/@*` and `https://polymarket.com/profile/*`.
- No network requests, API keys, or off-page scraping are used.
- Rows are classified from visible page text plus Polymarket event/category href paths using local keyword maps and team names.
- Profile list rows that Polymarket renders without event links, such as closed-position category rows and yield-only activity rows, are handled through conservative virtual-list row detection.
- SPA navigation, profile tab switches, sorting, search updates, lazy-loaded rows, and show-more inserts are handled with `MutationObserver`, History API hooks, `popstate`, and a lightweight URL poll.
- The extension fails open for page structure: it only hides row-like elements with known classifier keywords and leaves profile headers, tabs, search controls, footer, and unrelated sections alone.

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

Capture before/after screenshots for visual inspection:

```bash
npm run qa:screenshots
```

Live QA screenshots and reports are written to `.qa/`, which is intentionally ignored by git.

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
