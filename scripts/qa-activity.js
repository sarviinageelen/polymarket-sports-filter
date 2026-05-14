const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(ROOT, ".qa", "activity");
const PROFILE_DIR = path.join(os.tmpdir(), "psf-activity-profile-qa");
const STORAGE_KEY = "selectedSports";
const TARGET_URL =
  process.env.PSF_ACTIVITY_TARGET_URL ||
  "https://polymarket.com/profile/0x03e4bf005d66269e6eec3297346e48cca836c185";
const DEFAULT_COOKIE_JSON = path.join(ROOT, "cookie.json");
const COOKIE_JSON_PATH =
  process.env.POLYMARKET_COOKIE_JSON ||
  process.env.COOKIE_JSON ||
  (fs.existsSync(DEFAULT_COOKIE_JSON) ? DEFAULT_COOKIE_JSON : "");
const ALLOW_ANONYMOUS = process.env.PSF_ACTIVITY_ALLOW_ANONYMOUS === "1";
const SHOW_MORE_CLICKS = Number(process.env.PSF_ACTIVITY_SHOW_MORE_CLICKS || 10);
const ALL_SPORTS = ["nba", "nfl", "mlb", "nhl", "soccer", "tennis", "esports"];

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
      "--window-size=1400,1000",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
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

function cookieUrl(cookie) {
  if (cookie.url) {
    return cookie.url;
  }

  const domain = String(cookie.domain || "polymarket.com").replace(/^\./, "");
  const cookiePath = cookie.path || "/";
  return `https://${domain}${cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`}`;
}

function normalizeSameSite(value) {
  const normalized = String(value || "").toLowerCase();

  if (normalized === "strict") {
    return "Strict";
  }

  if (normalized === "lax") {
    return "Lax";
  }

  if (normalized === "none" || normalized === "no_restriction" || normalized === "no restriction") {
    return "None";
  }

  return undefined;
}

function normalizeCookie(cookie) {
  if (!cookie || !cookie.name || cookie.value == null) {
    return null;
  }

  const normalized = {
    name: String(cookie.name),
    value: String(cookie.value),
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  const sameSite = normalizeSameSite(cookie.sameSite || cookie.same_site);
  let expires = Number(cookie.expires ?? cookie.expirationDate);

  if (expires > 1e12) {
    expires = Math.floor(expires / 1000);
  }

  if (sameSite) {
    normalized.sameSite = sameSite;
  }

  if (cookie.domain) {
    normalized.domain = cookie.domain;
  } else {
    normalized.url = cookieUrl(cookie);
  }

  if (Number.isFinite(expires) && expires > 0 && !cookie.session) {
    normalized.expires = expires;
  }

  return normalized;
}

function readCookieJson(filePath) {
  if (!filePath) {
    return [];
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rawCookies = Array.isArray(payload) ? payload : payload.cookies || [];

  return rawCookies.map(normalizeCookie).filter(Boolean);
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
  await sleep(1400);
}

async function getLoginState(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const controls = [...document.querySelectorAll("button, a")]
        .filter(visible)
        .map((element) => clean(element.textContent));

      return {
        loggedOut: controls.includes("Log In") || controls.includes("Sign Up"),
        hasDeposit: controls.includes("Deposit"),
        controls: controls.slice(0, 80),
      };
    })()`
  );
}

async function openPage(cdp, url, cookies) {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId
  );

  if (cookies.length) {
    await cdp.send("Network.setCookies", { cookies }, sessionId);
  }

  await cdp.send("Page.navigate", { url }, sessionId);
  await waitForEvaluate(
    cdp,
    sessionId,
    `document.readyState === "complete" && /Positions|Activity|Predictions|Polymarket/.test(document.body.innerText)`,
    60000
  );
  await sleep(3500);

  return { targetId: target.targetId, sessionId };
}

async function clickVisibleText(cdp, sessionId, text) {
  const box = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const wanted = ${JSON.stringify(text)}.toLowerCase();
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const element = [...document.querySelectorAll("button, a, [role='tab']")]
        .find((item) => clean(item.textContent).toLowerCase() === wanted && visible(item));

      if (!element) {
        return null;
      }

      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()`
  );

  if (!box) {
    return false;
  }

  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
  await sleep(1800);
  return true;
}

async function clickShowMoreActivity(cdp, sessionId, contextId, maxClicks) {
  let clicks = 0;

  for (let index = 0; index < maxClicks; index += 1) {
    const state = await collectActivityState(cdp, sessionId, contextId);

    if (state.visibleNbaRows.length || !state.showMoreVisible) {
      break;
    }

    const clicked = await clickVisibleText(cdp, sessionId, "Show more activity");

    if (!clicked) {
      break;
    }

    clicks += 1;
    await sleep(2500);
  }

  return clicks;
}

async function collectActivityState(cdp, sessionId, contextId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const api = window.PolymarketSportsFilter;
      const clean = (text) => String(text || "").replace(/\\s+/g, " ").trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const linkClassText = (link) => {
        try {
          const url = new URL(link.href, location.href);
          if (url.hostname !== "polymarket.com" || !/\\/(event|market|sports|esports)\\//i.test(url.pathname)) return "";
          return decodeURIComponent(url.pathname).replace(/[\\/_-]+/g, " ");
        } catch (error) {
          return "";
        }
      };
      const classText = (row) => clean([
        row.textContent,
        [...row.querySelectorAll("a[href]")].map(linkClassText).filter(Boolean).join(" ")
      ].join(" "));
      const rows = [...document.querySelectorAll("main [data-psf-filtered]")].map((row) => {
        const text = classText(row);
        const rowVisible = visible(row) && !row.closest(".psf-hidden-row");

        return {
          text: clean(row.textContent).slice(0, 300),
          visible: rowVisible,
          filtered: row.dataset.psfFiltered || "",
          categories: api.classifyMarketText(text),
          allowedNba: api.matchesSelectedSports(text, ["nba"]),
        };
      });

      return {
        url: location.href,
        extensionActive: Boolean(api && document.getElementById("psf-style")),
        visibleRows: rows.filter((row) => row.visible),
        visibleNbaRows: rows.filter((row) => row.visible && row.allowedNba),
        visibleKnownDisallowedRows: rows.filter((row) => row.visible && row.categories.length && !row.allowedNba),
        hiddenRows: rows.filter((row) => row.filtered === "hidden"),
        filteredRows: rows.length,
        showMoreVisible: [...document.querySelectorAll("button, a")]
          .some((element) => clean(element.textContent).toLowerCase() === "show more activity" && visible(element)),
        textSample: clean(document.body.innerText).slice(0, 1200),
      };
    })()`,
    10000,
    contextId
  );
}

async function saveScreenshot(cdp, sessionId, filename) {
  const result = await cdp.send(
    "Page.captureScreenshot",
    { captureBeyondViewport: false, format: "png", fromSurface: true },
    sessionId
  );
  const outputPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(outputPath, Buffer.from(result.data, "base64"));
  return outputPath;
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!COOKIE_JSON_PATH && !ALLOW_ANONYMOUS) {
    throw new Error(
      "Set POLYMARKET_COOKIE_JSON to an exported cookie JSON path, or set PSF_ACTIVITY_ALLOW_ANONYMOUS=1 for a public-session probe."
    );
  }

  const cookies = readCookieJson(COOKIE_JSON_PATH);
  const child = launchChrome();
  const cdp = new PipeCdp(child);

  try {
    await cdp.send("Browser.getVersion");
    const extension = await cdp.send("Extensions.loadUnpacked", { path: ROOT });
    const page = await openPage(cdp, TARGET_URL, cookies);
    const loginState = await getLoginState(cdp, page.sessionId);

    if (cookies.length && loginState.loggedOut && !ALLOW_ANONYMOUS) {
      throw new Error(
        `Imported ${cookies.length} cookies from ${COOKIE_JSON_PATH}, but Polymarket still rendered a logged-out session. Export a fresh cookie.json or include the missing auth storage.`
      );
    }

    const context = await waitForExtensionContext(cdp, page.sessionId);

    await waitForEvaluate(cdp, page.sessionId, "Boolean(window.PolymarketSportsFilter)", 30000, context.id);
    await waitForEvaluate(cdp, page.sessionId, `Boolean(document.getElementById("psf-style"))`, 30000);

    await setSports(cdp, page.sessionId, context.id, ALL_SPORTS);
    assert.equal(await clickVisibleText(cdp, page.sessionId, "Activity"), true, "Activity tab should be clickable");

    const showMoreClicks = await clickShowMoreActivity(cdp, page.sessionId, context.id, SHOW_MORE_CLICKS);

    await setSports(cdp, page.sessionId, context.id, ["nba"]);
    const state = await collectActivityState(cdp, page.sessionId, context.id);
    const screenshot = await saveScreenshot(cdp, page.sessionId, "profile-activity.png");
    const output = path.join(OUT_DIR, "profile-activity-report.json");
    const report = {
      targetUrl: TARGET_URL,
      cookieJsonPath: COOKIE_JSON_PATH || null,
      cookiesImported: cookies.length,
      loginState,
      extensionId: extension.id,
      showMoreClicks,
      screenshot,
      state,
    };
    fs.writeFileSync(output, JSON.stringify(report, null, 2));

    assert.equal(state.extensionActive, true, JSON.stringify(state));
    assert.equal(state.visibleNbaRows.length > 0, true, `Expected NBA Activity rows after Show More. Report: ${output}`);
    assert.equal(
      state.visibleKnownDisallowedRows.length,
      0,
      `Expected known non-NBA Activity rows to be filtered out. Report: ${output}`
    );

    console.log(
      JSON.stringify(
        {
          output,
          screenshot,
          cookiesImported: cookies.length,
          showMoreClicks,
          visibleNbaRows: state.visibleNbaRows.slice(0, 5),
          hiddenRows: state.hiddenRows.length,
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
