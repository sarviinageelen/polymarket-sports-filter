const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_DIR = path.join(os.tmpdir(), "psf-pipe-profile-live-qa");
const TARGET_URL = "https://polymarket.com/@takumi-crypto-81";
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

        if (message.error) {
          pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
        } else {
          pending.resolve(message.result);
        }
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
      "--window-size=1400,1000",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: false,
    }
  );

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (/ERROR|Failed|extension/i.test(text)) {
      process.stderr.write(text);
    }
  });

  return child;
}

async function waitForEvent(cdp, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const event = cdp.events.find(predicate);

    if (event) {
      return event;
    }

    await sleep(250);
  }

  throw new Error("Timed out waiting for CDP event");
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

async function waitForEvaluate(cdp, sessionId, expression, timeoutMs = 30000, contextId = null) {
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

async function waitForExtensionContext(cdp, pageSessionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const event = cdp.events.find(
      (item) =>
        item.sessionId === pageSessionId &&
        item.method === "Runtime.executionContextCreated" &&
        item.params &&
        item.params.context &&
        item.params.context.origin &&
        item.params.context.origin.startsWith("chrome-extension://")
    );

    if (event) {
      return event.params.context;
    }

    await sleep(500);
  }

  throw new Error("Could not find content-script extension context");
}

async function run() {
  const child = launchChrome();
  const cdp = new PipeCdp(child);

  try {
    await cdp.send("Browser.getVersion");

    const extension = await cdp.send("Extensions.loadUnpacked", { path: ROOT });
    console.log(`Loaded extension id: ${extension.id}`);

    const target = await cdp.send("Target.createTarget", { url: TARGET_URL });
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const pageSessionId = attached.sessionId;

    await cdp.send("Runtime.enable", {}, pageSessionId);
    await cdp.send("Page.enable", {}, pageSessionId);

    await waitForEvaluate(
      cdp,
      pageSessionId,
      `document.readyState === "complete" && location.href.startsWith(${JSON.stringify(TARGET_URL)})`
    );

    const extensionContext = await waitForExtensionContext(cdp, pageSessionId);
    await waitForEvaluate(cdp, pageSessionId, "Boolean(window.PolymarketSportsFilter)", 30000, extensionContext.id);

    const initial = await evaluate(
      cdp,
      pageSessionId,
      `new Promise((resolve) => chrome.storage.sync.get({${JSON.stringify(
        STORAGE_KEY
      )}: ["nba"]}, (items) => resolve(items.${STORAGE_KEY})))`,
      10000,
      extensionContext.id
    );
    assert.deepEqual(initial, ["nba"]);

    await waitForEvaluate(cdp, pageSessionId, `Boolean(document.getElementById("psf-style"))`);

    const syntheticRowsReadyExpression = `(() => {
      let host = document.getElementById("psf-live-qa-host");

      if (!host) {
        host = document.createElement("section");
        host.id = "psf-live-qa-host";
      }

      host.innerHTML = [
        '<h2>QA Synthetic Rows</h2>',
        '<div data-qa-row="nba"><a href="/event/qa-nba">Lakers vs. Thunder</a></div>',
        '<div data-qa-row="nfl"><a href="/event/qa-nfl">Chiefs vs. Eagles</a></div>',
        '<div data-qa-row="crypto"><a href="/event/qa-crypto">Will Bitcoin hit $100k in 2026?</a></div>',
        '<div data-qa-row="unknown"><a href="/event/qa-unknown">Will the next mystery market resolve yes?</a></div>',
        '<div data-qa-row="non-market">Will the next mystery market resolve yes?</div>'
      ].join("");

      const main = document.querySelector("main");

      if (!main) {
        return false;
      }

      if (!host.isConnected) {
        main.appendChild(host);
      }

      return document.querySelectorAll("#psf-live-qa-host [data-qa-row]").length === 5;
    })()`;

    await waitForEvaluate(cdp, pageSessionId, syntheticRowsReadyExpression);

    await waitForEvaluate(cdp, pageSessionId, syntheticRowsReadyExpression);
    await sleep(1500);

    const defaultFilter = await evaluate(
      cdp,
      pageSessionId,
      `(() => Object.fromEntries([...document.querySelectorAll("#psf-live-qa-host [data-qa-row]")].map((row) => [row.dataset.qaRow, {
        hidden: getComputedStyle(row).display === "none",
        filtered: row.dataset.psfFiltered || ""
      }])))()`
    );
    assert.equal(defaultFilter.nba.hidden, false, JSON.stringify(defaultFilter));
    assert.equal(defaultFilter.nfl.hidden, true, JSON.stringify(defaultFilter));
    assert.equal(defaultFilter.crypto.hidden, true, JSON.stringify(defaultFilter));
    assert.equal(defaultFilter.unknown.hidden, true, JSON.stringify(defaultFilter));
    assert.equal(defaultFilter["non-market"].hidden, false, JSON.stringify(defaultFilter));

    const visibleDisallowedDefault = await evaluate(
      cdp,
      pageSessionId,
      `(() => {
        const api = window.PolymarketSportsFilter;
        const seen = new Set();
        const disallowed = [];

        function isVisible(element) {
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
        }

        [...document.querySelectorAll("main a[href*='/event/'], main a[href*='/market/']")]
          .filter((link) => !link.closest("#psf-live-qa-host") && !link.closest(".psf-hidden-row") && isVisible(link))
          .forEach((link) => {
            const row = link.closest("[data-psf-filtered='shown']") || link;
            const text = row.textContent.replace(/\\s+/g, " ").trim();

            if (!text || seen.has(text)) {
              return;
            }

            seen.add(text);

            if (!api.matchesSelectedSports(text, ["nba"])) {
              disallowed.push(text);
            }
          });

        return { count: disallowed.length, samples: disallowed.slice(0, 10) };
      })()`,
      10000,
      extensionContext.id
    );
    assert.equal(visibleDisallowedDefault.count, 0, JSON.stringify(visibleDisallowedDefault));

    await evaluate(
      cdp,
      pageSessionId,
      `new Promise((resolve) => chrome.storage.sync.set({${JSON.stringify(
        STORAGE_KEY
      )}: ["nba", "nfl"]}, () => resolve(true)))`,
      10000,
      extensionContext.id
    );

    await sleep(1500);

    const multiSportFilter = await evaluate(
      cdp,
      pageSessionId,
      `(() => Object.fromEntries([...document.querySelectorAll("#psf-live-qa-host [data-qa-row]")].map((row) => [row.dataset.qaRow, {
        hidden: getComputedStyle(row).display === "none",
        filtered: row.dataset.psfFiltered || ""
      }])))()`
    );
    assert.equal(multiSportFilter.nba.hidden, false, JSON.stringify(multiSportFilter));
    assert.equal(multiSportFilter.nfl.hidden, false, JSON.stringify(multiSportFilter));
    assert.equal(multiSportFilter.crypto.hidden, true, JSON.stringify(multiSportFilter));
    assert.equal(multiSportFilter.unknown.hidden, true, JSON.stringify(multiSportFilter));
    assert.equal(multiSportFilter["non-market"].hidden, false, JSON.stringify(multiSportFilter));

    await evaluate(
      cdp,
      pageSessionId,
      `(() => {
        const row = document.createElement("div");
        row.dataset.qaRow = "lazy-mlb";
        row.innerHTML = '<a href="/event/qa-mlb">Yankees vs. Dodgers</a>';
        document.getElementById("psf-live-qa-host").appendChild(row);
      })()`
    );
    await sleep(1500);

    const lazyState = await evaluate(
      cdp,
      pageSessionId,
      `(() => {
        const row = document.querySelector('[data-qa-row="lazy-mlb"]');
        return { hidden: getComputedStyle(row).display === "none", filtered: row.dataset.psfFiltered || "" };
      })()`
    );
    assert.equal(lazyState.hidden, true, JSON.stringify(lazyState));

    const pageState = await evaluate(
      cdp,
      pageSessionId,
      `(() => ({
        title: document.title,
        url: location.href,
        styleInjected: Boolean(document.getElementById("psf-style")),
        hiddenRows: document.querySelectorAll(".psf-hidden-row").length,
        filteredRows: document.querySelectorAll("[data-psf-filtered]").length,
        profileHeaderHidden: Boolean(document.querySelector("header.psf-hidden-row, nav.psf-hidden-row")),
        realPageHasNbaText: /Lakers vs\\. Thunder|Spurs vs\\. Timberwolves|76ers vs\\. Knicks|Cavaliers vs\\. Pistons/i.test(document.body.innerText),
        realPageHasKnownNonNbaText: /Will Bitcoin|Will SpaceX|FIFA World Cup|Will Elon Musk|Brazilian presidential election/i.test(document.body.innerText),
        profileInfoVisible: (() => {
          function visible(element) {
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
          }

          const visibleText = [...document.querySelectorAll("main *")]
            .filter(visible)
            .map((element) => element.textContent.replace(/\\s+/g, " ").trim())
            .join(" ");

          return /Takumi-Crypto-81/i.test(visibleText) &&
            /Positions Value/i.test(visibleText) &&
            /Profit\\/Loss/i.test(visibleText);
        })()
      }))()`
    );
    assert.equal(pageState.profileHeaderHidden, false, JSON.stringify(pageState));
    assert.equal(pageState.realPageHasNbaText, true, JSON.stringify(pageState));
    assert.equal(pageState.realPageHasKnownNonNbaText, false, JSON.stringify(pageState));
    assert.equal(pageState.profileInfoVisible, true, JSON.stringify(pageState));

    console.log(
      JSON.stringify(
        {
          targetUrl: TARGET_URL,
          extensionId: extension.id,
          defaultFilter,
          multiSportFilter,
          lazyState,
          pageState,
        },
        null,
        2
      )
    );
  } finally {
    child.kill();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
