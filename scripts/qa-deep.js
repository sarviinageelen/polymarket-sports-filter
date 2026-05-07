const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(ROOT, ".qa", "deep-qa");
const PROFILE_DIR = path.join(os.tmpdir(), "psf-deep-profile-qa");
const STORAGE_KEY = "selectedSports";

const PROFILES = [
  { label: "takumi", url: "https://polymarket.com/@takumi-crypto-81", expectNba: true },
  { label: "car", url: "https://polymarket.com/@car" },
  { label: "parz1vai", url: "https://polymarket.com/@parz1vai" },
  { label: "sharky6999", url: "https://polymarket.com/@sharky6999" },
  { label: "scottilicious", url: "https://polymarket.com/@scottilicious" },
  {
    label: "wallet-profile-route",
    url: "https://polymarket.com/profile/0xb10047d6a254b2ebb306d7a7d13bf59171ab6461",
  },
];

const VIEWPORTS = [
  { label: "desktop", width: 1400, height: 1000 },
  { label: "mobile", width: 390, height: 844 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slug(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));

  if (!found) {
    throw new Error("Could not find Chrome or Edge. Set CHROME_PATH to a Chromium executable.");
  }

  return found;
}

class PipeCdp {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.buffer = Buffer.alloc(0);

    child.stdio[4].on("data", (chunk) => this.handleData(chunk));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const index = this.buffer.indexOf(0);

      if (index === -1) {
        return;
      }

      const raw = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);

      if (!raw) {
        continue;
      }

      const message = JSON.parse(raw);

      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`)) : pending.resolve(message.result);
      } else {
        this.events.push(message);
      }
    }
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId;
    this.nextId += 1;

    const payload = { id, method, params };

    if (sessionId) {
      payload.sessionId = sessionId;
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.child.stdio[3].write(`${JSON.stringify(payload)}\0`);
    return promise;
  }
}

function launchChrome() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const child = childProcess.spawn(
    findChrome(),
    [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: false,
    }
  );

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (/extension/i.test(text)) {
      process.stderr.write(text);
    }
  });

  return child;
}

async function evaluate(cdp, sessionId, expression, timeout = 10000, contextId = null) {
  const params = {
    awaitPromise: true,
    expression,
    returnByValue: true,
    timeout,
  };

  if (contextId) {
    params.contextId = contextId;
  }

  const result = await cdp.send("Runtime.evaluate", params, sessionId);

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }

  return result.result.value;
}

async function waitForEvaluate(cdp, sessionId, expression, timeoutMs = 45000, contextId = null) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await evaluate(cdp, sessionId, expression, 5000, contextId);

    if (lastValue) {
      return lastValue;
    }

    await sleep(750);
  }

  throw new Error(`Timed out waiting for ${expression}; last value=${JSON.stringify(lastValue)}`);
}

async function waitForExtensionContext(cdp, sessionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const contextEvent = cdp.events.find(
      (event) =>
        event.sessionId === sessionId &&
        event.method === "Runtime.executionContextCreated" &&
        event.params &&
        event.params.context &&
        event.params.context.origin &&
        event.params.context.origin.startsWith("chrome-extension://")
    );

    if (contextEvent) {
      return contextEvent.params.context;
    }

    await sleep(500);
  }

  throw new Error("content script execution context was not created");
}

async function openPage(cdp, url, viewport) {
  const target = await cdp.send("Target.createTarget", { url });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width < 600,
    },
    sessionId
  );

  await waitForEvaluate(
    cdp,
    sessionId,
    `document.readyState === "complete" && /Positions|Activity|Predictions|Polymarket/.test(document.body.innerText)`
  );
  await sleep(2500);

  return sessionId;
}

async function saveScreenshot(cdp, sessionId, filename) {
  const result = await cdp.send(
    "Page.captureScreenshot",
    {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
    },
    sessionId
  );

  const outputPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(outputPath, Buffer.from(result.data, "base64"));
  return outputPath;
}

async function setSports(cdp, sessionId, contextId, selectedSports) {
  await evaluate(
    cdp,
    sessionId,
    `new Promise((resolve) => chrome.storage.sync.set({${JSON.stringify(
      STORAGE_KEY
    )}: ${JSON.stringify(selectedSports)}}, () => resolve(true)))`,
    10000,
    contextId
  );
  await sleep(1200);
}

async function clickText(cdp, sessionId, text) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const targetText = ${JSON.stringify(text)};
      const element = [...document.querySelectorAll("button, a, [role='tab']")]
        .find((item) => item.textContent.replace(/\\s+/g, " ").trim().toLowerCase() === targetText.toLowerCase());

      if (!element) {
        return false;
      }

      element.click();
      return true;
    })()`
  );
}

async function assertState(cdp, sessionId, contextId, label, selectedSports) {
  const state = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const api = window.PolymarketSportsFilter;
      const selectedSports = ${JSON.stringify(selectedSports)};

      function clean(text) {
        return String(text || "").replace(/\\s+/g, " ").trim();
      }

      function visible(element) {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      }

      const filterableLinkSelector = "a[href*='/event/'], a[href*='/market/'], a[href*='/sports/'], a[href*='/esports/']";
      const virtualRowSelector = "[data-index][data-item-index], [data-item-index][data-known-size]";
      const profileListPattern = /\\b(won|lost|bought|sold|redeemed|yield|shares?|holdings yield|ago|at\\s+\\d+(?:\\.\\d+)?\\s*¢|\\$[\\d,.]+|\\d+(?:\\.\\d+)?\\s*¢)\\b/i;

      function rowFor(link) {
        return link.closest(virtualRowSelector) ||
          link.closest("[data-psf-filtered]") ||
          link;
      }

      function linkClassText(link) {
        try {
          const url = new URL(link.href, location.href);

          if (url.hostname !== "polymarket.com" || !/\\/(event|market|sports|esports)\\//i.test(url.pathname)) {
            return "";
          }

          return decodeURIComponent(url.pathname).replace(/[\\/_-]+/g, " ");
        } catch (error) {
          return "";
        }
      }

      function classText(row) {
        return clean([
          row.textContent,
          [...row.querySelectorAll("a[href]")].map(linkClassText).filter(Boolean).join(" ")
        ].join(" "));
      }

      const visibleText = [...document.querySelectorAll("main *")]
        .filter(visible)
        .map((element) => clean(element.textContent))
        .join(" ");

      const links = [...document.querySelectorAll("main " + filterableLinkSelector)]
        .filter((link) => !link.closest("footer, nav, header") && visible(link));

      const visibleRows = [];
      const seenRows = new Set();

      function addRow(row, href) {
        if (!row || seenRows.has(row)) {
          return;
        }

        if (!visible(row) || row.closest(".psf-hidden-row")) {
          return;
        }

        seenRows.add(row);

        const text = clean(row.textContent);

        if (!text) {
          return;
        }

        const classificationText = classText(row);

        visibleRows.push({
          text,
          href: href || "",
          categories: api.classifyMarketText(classificationText),
          allowed: api.matchesSelectedSports(classificationText, selectedSports)
        });
      }

      links.forEach((link) => addRow(rowFor(link), link.href));

      [...document.querySelectorAll("main " + virtualRowSelector)].forEach((row) => {
        if (!profileListPattern.test(clean(row.textContent))) {
          return;
        }

        addRow(row, "");
      });

      const disallowed = visibleRows.filter((row) => !row.allowed);

      return {
        label: ${JSON.stringify(label)},
        url: location.href,
        extensionActive: Boolean(document.getElementById("psf-style")),
        title: document.title,
        profileInfoVisible: /Positions Value/i.test(visibleText) && /Predictions/i.test(visibleText),
        chartVisible: /Profit\\/Loss|Portfolio Profit\\/Loss Chart/i.test(visibleText),
        positionsControlsVisible: /Positions/i.test(visibleText) && /Activity/i.test(visibleText),
        hiddenRows: document.querySelectorAll(".psf-hidden-row").length,
        filteredRows: document.querySelectorAll("[data-psf-filtered]").length,
        visibleRows: visibleRows.slice(0, 12),
        visibleRowCount: visibleRows.length,
        disallowed,
        disallowedCount: disallowed.length,
        hasNbaVisible: visibleRows.some((row) => row.allowed && row.categories.includes("nba")),
        visibleTextSample: visibleText.slice(0, 1000)
      };
    })()`,
    10000,
    contextId
  );

  assert.equal(state.extensionActive, true, `${label}: extension did not inject`);
  assert.equal(state.profileInfoVisible, true, `${label}: profile stats hidden`);
  assert.equal(state.positionsControlsVisible, true, `${label}: positions/activity controls hidden`);
  assert.equal(state.disallowedCount, 0, `${label}: visible disallowed rows ${JSON.stringify(state.disallowed.slice(0, 5))}`);

  return state;
}

async function searchPositions(cdp, sessionId, query) {
  const box = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const input = [...document.querySelectorAll("input")]
        .find((item) => /search/i.test(item.placeholder || item.getAttribute("aria-label") || ""));

      if (!input) {
        return null;
      }

      input.scrollIntoView({ block: "center", inline: "center" });
      const rect = input.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };
    })()`
  );

  if (!box) {
    return false;
  }

  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, windowsVirtualKeyCode: 65, code: "KeyA", key: "a" }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, windowsVirtualKeyCode: 65, code: "KeyA", key: "a" }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 8, code: "Backspace", key: "Backspace" }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 8, code: "Backspace", key: "Backspace" }, sessionId);
  await cdp.send("Input.insertText", { text: query }, sessionId);
  await sleep(1500);

  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const input = [...document.querySelectorAll("input")]
        .find((item) => /search/i.test(item.placeholder || item.getAttribute("aria-label") || ""));
      return Boolean(input && input.value === ${JSON.stringify(query)});
    })()`
  );
}

async function runProfile(cdp, profile, viewport) {
  const label = `${profile.label}-${viewport.label}`;
  const sessionId = await openPage(cdp, profile.url, viewport);
  const context = await waitForExtensionContext(cdp, sessionId);
  await waitForEvaluate(cdp, sessionId, "Boolean(window.PolymarketSportsFilter)", 30000, context.id);
  await waitForEvaluate(cdp, sessionId, `Boolean(document.getElementById("psf-style"))`);

  await setSports(cdp, sessionId, context.id, ["nba"]);
  const nbaState = await assertState(cdp, sessionId, context.id, `${label}:nba`, ["nba"]);

  if (profile.expectNba) {
    assert.equal(nbaState.hasNbaVisible, true, `${label}: expected at least one visible NBA row`);
  }

  const screenshot = await saveScreenshot(cdp, sessionId, `${slug(label)}-nba.png`);

  await evaluate(cdp, sessionId, "window.scrollBy(0, Math.round(window.innerHeight * 1.5)); true");
  await sleep(1500);
  const scrolledState = await assertState(cdp, sessionId, context.id, `${label}:scroll`, ["nba"]);

  await evaluate(cdp, sessionId, "window.scrollTo(0, 0); true");
  await sleep(1000);

  const clickedActivity = await clickText(cdp, sessionId, "Activity");
  let activityState = null;

  if (clickedActivity) {
    await sleep(2000);
    activityState = await assertState(cdp, sessionId, context.id, `${label}:activity`, ["nba"]);
  }

  await clickText(cdp, sessionId, "Positions");
  await sleep(1000);
  const clickedClosed = await clickText(cdp, sessionId, "Closed");
  let closedState = null;

  if (clickedClosed) {
    await sleep(2000);
    closedState = await assertState(cdp, sessionId, context.id, `${label}:closed`, ["nba"]);
  }

  await clickText(cdp, sessionId, "Active");
  await sleep(1000);
  const didSearch = await searchPositions(cdp, sessionId, "Bitcoin");
  let searchState = null;

  if (didSearch) {
    await sleep(1500);
    searchState = await assertState(cdp, sessionId, context.id, `${label}:search-bitcoin`, ["nba"]);
  }

  await setSports(cdp, sessionId, context.id, ["nba", "nfl"]);
  const multiSportState = await assertState(cdp, sessionId, context.id, `${label}:nba-nfl`, ["nba", "nfl"]);

  await cdp.send("Target.closeTarget", { targetId: sessionId.split(".")[0] }).catch(() => {});

  return {
    label,
    url: nbaState.url,
    screenshot,
    nba: {
      hiddenRows: nbaState.hiddenRows,
      visibleRowCount: nbaState.visibleRowCount,
      hasNbaVisible: nbaState.hasNbaVisible,
    },
    scrolled: {
      visibleRowCount: scrolledState.visibleRowCount,
      hiddenRows: scrolledState.hiddenRows,
    },
    activity: activityState
      ? { visibleRowCount: activityState.visibleRowCount, hiddenRows: activityState.hiddenRows }
      : { skipped: true },
    closed: closedState ? { visibleRowCount: closedState.visibleRowCount, hiddenRows: closedState.hiddenRows } : { skipped: true },
    searchBitcoin: searchState
      ? { visibleRowCount: searchState.visibleRowCount, hiddenRows: searchState.hiddenRows }
      : { skipped: true },
    nbaNfl: {
      visibleRowCount: multiSportState.visibleRowCount,
      hiddenRows: multiSportState.hiddenRows,
    },
  };
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const child = launchChrome();
  const cdp = new PipeCdp(child);
  const results = [];
  const failures = [];

  try {
    await cdp.send("Browser.getVersion");
    const extension = await cdp.send("Extensions.loadUnpacked", { path: ROOT });

    for (const profile of PROFILES) {
      for (const viewport of VIEWPORTS) {
        if (viewport.label === "mobile" && !["takumi", "car"].includes(profile.label)) {
          continue;
        }

        try {
          const result = await runProfile(cdp, profile, viewport);
          results.push(result);
          console.log(`PASS ${result.label}`);
        } catch (error) {
          const failure = {
            label: `${profile.label}-${viewport.label}`,
            url: profile.url,
            error: error.message,
          };
          failures.push(failure);
          console.error(`FAIL ${failure.label}: ${failure.error}`);
        }
      }
    }

    const report = {
      extensionId: extension.id,
      total: results.length + failures.length,
      passed: results.length,
      failed: failures.length,
      results,
      failures,
    };

    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    if (failures.length) {
      process.exitCode = 1;
    }
  } finally {
    child.kill();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
