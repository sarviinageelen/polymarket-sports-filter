const childProcess = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_DIR = path.join(os.tmpdir(), "psf-diagnose-takumi-sequence");
const OUT_DIR = path.resolve(ROOT, ".qa", "diagnostics");
const STORAGE_KEY = "selectedSports";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const params = { awaitPromise: true, expression, returnByValue: true, timeout };

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

    await sleep(500);
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

async function openPage(cdp, url) {
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
    { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false },
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

async function clickExactText(cdp, sessionId, text) {
  const clicked = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const wanted = ${JSON.stringify(text)}.toLowerCase();
      const candidates = [...document.querySelectorAll("button, a, [role='tab']")]
        .filter((item) => item.textContent.replace(/\\s+/g, " ").trim().toLowerCase() === wanted);
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const element = candidates.find(visible) || candidates[0];

      if (!element) {
        return false;
      }

      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    })()`,
  );

  await sleep(1800);
  return clicked;
}

async function saveScreenshot(cdp, sessionId, name) {
  const result = await cdp.send(
    "Page.captureScreenshot",
    { captureBeyondViewport: false, format: "png", fromSurface: true },
    sessionId
  );
  const outputPath = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(outputPath, Buffer.from(result.data, "base64"));
  return outputPath;
}

async function collectState(cdp, sessionId, contextId, label) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const api = window.PolymarketSportsFilter;

      function clean(text) {
        return String(text || "").replace(/\\s+/g, " ").trim();
      }

      function visible(element) {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      }

      function rowFor(link) {
        return link.closest("[data-index][data-item-index], [data-item-index][data-known-size]") ||
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

      const buttons = [...document.querySelectorAll("button, a, [role='tab']")]
        .filter(visible)
        .map((element) => ({
          text: clean(element.textContent),
          ariaSelected: element.getAttribute("aria-selected"),
          ariaPressed: element.getAttribute("aria-pressed"),
          href: element.href || "",
          tag: element.tagName.toLowerCase()
        }))
        .filter((item) => item.text);

      const links = [...document.querySelectorAll("main a[href*='/event/'], main a[href*='/market/']")];
      const marketRows = [];
      const seen = new Set();

      links.forEach((link) => {
        const row = rowFor(link);

        if (seen.has(row)) {
          return;
        }

        seen.add(row);

        const text = clean(row.textContent);
        const classificationText = classText(row);
        const isVisible = visible(row) && !row.closest(".psf-hidden-row");

        marketRows.push({
          text: text.slice(0, 300),
          href: link.href,
          rowTag: row.tagName.toLowerCase(),
          rowClass: row.className,
          filtered: row.dataset.psfFiltered || "",
          classHidden: row.classList.contains("psf-hidden-row"),
          visible: isVisible,
          categories: api ? api.classifyMarketText(classificationText) : [],
          allowedNba: api ? api.matchesSelectedSports(classificationText, ["nba"]) : null
        });
      });

      const visibleDisallowed = marketRows.filter((row) => row.visible && !row.allowedNba);
      const visibleAllowed = marketRows.filter((row) => row.visible && row.allowedNba);

      const categoryAnchors = [...document.querySelectorAll("main a[href*='/sports/'], main a[href*='/esports/']")]
        .filter(visible)
        .map((link) => {
          const virtualRow = link.closest("[data-index][data-item-index], [data-item-index][data-known-size]");
          const fallbackRow = link.closest("[role='row'], tr, li") || link.parentElement;
          const rect = (virtualRow || fallbackRow || link).getBoundingClientRect();

          return {
            text: clean(link.textContent).slice(0, 240),
            href: link.href,
            virtualText: virtualRow ? clean(virtualRow.textContent).slice(0, 360) : "",
            fallbackText: fallbackRow ? clean(fallbackRow.textContent).slice(0, 360) : "",
            virtualTag: virtualRow ? virtualRow.tagName.toLowerCase() : "",
            virtualAttrs: virtualRow
              ? {
                  index: virtualRow.getAttribute("data-index"),
                  itemIndex: virtualRow.getAttribute("data-item-index"),
                  knownSize: virtualRow.getAttribute("data-known-size")
                }
              : null,
            fallbackTag: fallbackRow ? fallbackRow.tagName.toLowerCase() : "",
            fallbackClass: fallbackRow ? fallbackRow.className : "",
            rect: { width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        })
        .slice(0, 80);

      const allVisibleAnchors = [...document.querySelectorAll("main a")]
        .filter(visible)
        .map((link) => ({ text: clean(link.textContent).slice(0, 180), href: link.href }))
        .filter((link) => link.text || link.href)
        .slice(0, 80);

      const virtualRows = [...document.querySelectorAll("main [data-index][data-item-index], main [data-item-index][data-known-size]")]
        .filter(visible)
        .map((row) => ({
          text: clean(row.textContent).slice(0, 420),
          filtered: row.dataset.psfFiltered || "",
          classHidden: row.classList.contains("psf-hidden-row"),
          attrs: {
            index: row.getAttribute("data-index"),
            itemIndex: row.getAttribute("data-item-index"),
            knownSize: row.getAttribute("data-known-size")
          },
          links: [...row.querySelectorAll("a")].map((link) => ({ text: clean(link.textContent), href: link.href })).slice(0, 8),
          rect: {
            width: Math.round(row.getBoundingClientRect().width),
            height: Math.round(row.getBoundingClientRect().height)
          }
        }))
        .slice(0, 40);

      return {
        label: ${JSON.stringify(label)},
        url: location.href,
        title: document.title,
        extensionActive: Boolean(document.getElementById("psf-style")),
        hiddenRows: document.querySelectorAll(".psf-hidden-row").length,
        filteredRows: document.querySelectorAll("[data-psf-filtered]").length,
        buttons: buttons.slice(0, 80),
        marketRowsCount: marketRows.length,
        visibleAllowedCount: visibleAllowed.length,
        visibleDisallowedCount: visibleDisallowed.length,
        visibleAllowed: visibleAllowed.slice(0, 12),
        visibleDisallowed: visibleDisallowed.slice(0, 12),
        marketRows: marketRows.slice(0, 40),
        categoryAnchors,
        virtualRows,
        visibleTextSample: clean(document.body.innerText).slice(0, 2000),
        allVisibleAnchors
      };
    })()`,
    10000,
    contextId
  );
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
  await sleep(1500);
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const child = launchChrome();
  const cdp = new PipeCdp(child);

  try {
    await cdp.send("Browser.getVersion");
    const extension = await cdp.send("Extensions.loadUnpacked", { path: ROOT });
    const sessionId = await openPage(cdp, "https://polymarket.com/@takumi-crypto-81");
    const context = await waitForExtensionContext(cdp, sessionId);

    await waitForEvaluate(cdp, sessionId, "Boolean(window.PolymarketSportsFilter)", 30000, context.id);
    await waitForEvaluate(cdp, sessionId, `Boolean(document.getElementById("psf-style"))`);
    await setSports(cdp, sessionId, context.id, ["nba"]);

    const initial = await collectState(cdp, sessionId, context.id, "initial");
    await saveScreenshot(cdp, sessionId, "initial");

    await clickExactText(cdp, sessionId, "Positions");
    await clickExactText(cdp, sessionId, "Closed");
    const closed = await collectState(cdp, sessionId, context.id, "positions-closed");
    await saveScreenshot(cdp, sessionId, "positions-closed");

    await clickExactText(cdp, sessionId, "Activity");
    const activityAfterClosed = await collectState(cdp, sessionId, context.id, "activity-after-closed");
    await saveScreenshot(cdp, sessionId, "activity-after-closed");

    const report = { extensionId: extension.id, initial, closed, activityAfterClosed };
    const output = path.join(OUT_DIR, "takumi-sequence-report.json");
    fs.writeFileSync(output, JSON.stringify(report, null, 2));

    assert.equal(
      /Counter-Strike|Rolex Monte Carlo Masters|Jannik Sinner/i.test(closed.visibleTextSample),
      false,
      "NBA-only Closed Positions should hide visible esports/tennis rows"
    );
    assert.equal(
      /Yield\s*Holdings yield|Holdings yield \(4% APR\)/i.test(activityAfterClosed.visibleTextSample),
      false,
      "NBA-only Activity should hide visible yield rows"
    );

    console.log(JSON.stringify({ output, extensionId: extension.id, states: {
      initial: {
        hiddenRows: initial.hiddenRows,
        visibleAllowedCount: initial.visibleAllowedCount,
        visibleDisallowedCount: initial.visibleDisallowedCount,
      },
      closed: {
        hiddenRows: closed.hiddenRows,
        visibleAllowedCount: closed.visibleAllowedCount,
        visibleDisallowedCount: closed.visibleDisallowedCount,
        visibleDisallowed: closed.visibleDisallowed.slice(0, 5),
      },
      activityAfterClosed: {
        hiddenRows: activityAfterClosed.hiddenRows,
        visibleAllowedCount: activityAfterClosed.visibleAllowedCount,
        visibleDisallowedCount: activityAfterClosed.visibleDisallowedCount,
        visibleDisallowed: activityAfterClosed.visibleDisallowed.slice(0, 5),
      },
    } }, null, 2));
  } finally {
    child.kill();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
