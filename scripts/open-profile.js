const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TARGET_URL =
  process.argv.find((arg) => /^https?:\/\//i.test(arg)) ||
  process.env.PSF_PROFILE_URL ||
  "https://polymarket.com/profile/0x03e4bf005d66269e6eec3297346e48cca836c185";
const CHECK_MODE = process.argv.includes("--check");
const FIND_NEXT_CHECK = process.argv.includes("--find-next-check");
const DEFAULT_COOKIE_JSON = path.join(ROOT, "cookie.json");
const DEFAULT_SESSION_JSON = path.join(ROOT, ".qa", "polymarket-session.json");
const COOKIE_JSON_PATH =
  process.env.POLYMARKET_COOKIE_JSON ||
  process.env.COOKIE_JSON ||
  (fs.existsSync(DEFAULT_COOKIE_JSON) ? DEFAULT_COOKIE_JSON : "");
const SESSION_JSON_PATH =
  process.env.POLYMARKET_SESSION_JSON ||
  (!process.argv.includes("--no-session") && fs.existsSync(DEFAULT_SESSION_JSON) ? DEFAULT_SESSION_JSON : "");
const PROFILE_DIR =
  process.env.PSF_OPEN_PROFILE_DIR ||
  path.join(os.tmpdir(), `psf-open-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`);
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
        message.error
          ? pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`))
          : pending.resolve(message.result);
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

function cookieUrl(cookie) {
  if (cookie.url) {
    return cookie.url;
  }

  const domain = String(cookie.domain || "polymarket.com").replace(/^\./, "");
  const cookiePath = cookie.path || "/";
  return `https://${domain}${cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`}`;
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
  if (!filePath || process.argv.includes("--no-cookies")) {
    return [];
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rawCookies = Array.isArray(payload) ? payload : payload.cookies || [];
  return rawCookies.map(normalizeCookie).filter(Boolean);
}

function readSessionJson(filePath) {
  if (!filePath || process.argv.includes("--no-session")) {
    return null;
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    cookies: Array.isArray(payload.cookies) ? payload.cookies.map(normalizeCookie).filter(Boolean) : [],
    localStorage: payload.localStorage && typeof payload.localStorage === "object" ? payload.localStorage : {},
    origin: payload.origin || "https://polymarket.com",
    sessionStorage: payload.sessionStorage && typeof payload.sessionStorage === "object" ? payload.sessionStorage : {},
  };
}

function launchChrome() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  return childProcess.spawn(
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

async function openProfile(cdp, url, cookies) {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);

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

  return { sessionId, targetId: target.targetId };
}

async function applyStorage(cdp, sessionId, sessionState) {
  if (!sessionState) {
    return;
  }

  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const localEntries = ${JSON.stringify(sessionState.localStorage)};
      const sessionEntries = ${JSON.stringify(sessionState.sessionStorage)};
      Object.entries(localEntries).forEach(([key, value]) => localStorage.setItem(key, String(value)));
      Object.entries(sessionEntries).forEach(([key, value]) => sessionStorage.setItem(key, String(value)));
      return true;
    })()`
  );
}

async function openPageWithSession(cdp, url, cookies, sessionState) {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);

  if (cookies.length) {
    await cdp.send("Network.setCookies", { cookies }, sessionId);
  }

  if (sessionState) {
    await cdp.send("Page.navigate", { url: sessionState.origin || "https://polymarket.com" }, sessionId);
    await waitForEvaluate(cdp, sessionId, `document.readyState === "complete"`, 60000);
    await applyStorage(cdp, sessionId, sessionState);
  }

  await cdp.send("Page.navigate", { url }, sessionId);
  await waitForEvaluate(
    cdp,
    sessionId,
    `document.readyState === "complete" && /Positions|Activity|Predictions|Polymarket/.test(document.body.innerText)`,
    60000
  );

  return { sessionId, targetId: target.targetId };
}

async function setDefaultSports(cdp, sessionId, contextId) {
  await evaluate(
    cdp,
    sessionId,
    `new Promise((resolve) => chrome.storage.sync.set({${JSON.stringify(
      STORAGE_KEY
    )}: ["nba"]}, () => resolve(true)))`,
    10000,
    contextId
  );
}

async function collectStatus(cdp, sessionId, contextId) {
  const pageStatus = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      return {
        url: location.href,
        title: document.title,
        extensionActive: Boolean(document.getElementById("psf-style")),
        filteredRows: document.querySelectorAll("[data-psf-filtered]").length,
        hiddenRows: document.querySelectorAll(".psf-hidden-row").length,
        loggedOut: [...document.querySelectorAll("button, a")]
          .filter(visible)
          .map((element) => clean(element.textContent))
          .some((text) => text === "Log In" || text === "Sign Up"),
        sample: clean(document.body.innerText).slice(0, 500),
      };
    })()`
  );

  const runtimeStatus = contextId
    ? await evaluate(
        cdp,
        sessionId,
        `window.PolymarketSportsFilterRuntime ? window.PolymarketSportsFilterRuntime.getStatus() : null`,
        10000,
        contextId
      )
    : null;

  return { ...pageStatus, runtimeStatus };
}

async function run() {
  let child = null;
  let shuttingDown = false;

  function shutdown(code = 0) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (child) {
      child.kill();
    }
    process.exit(code);
  }

  try {
    const sessionState = readSessionJson(SESSION_JSON_PATH);
    const cookies = sessionState && sessionState.cookies.length ? sessionState.cookies : readCookieJson(COOKIE_JSON_PATH);
    child = launchChrome();
    const cdp = new PipeCdp(child);

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (/ERROR|Failed|extension/i.test(text)) {
        process.stderr.write(text);
      }
    });

    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    child.on("exit", (code) => {
      if (!shuttingDown) {
        process.exit(code || 0);
      }
    });

    await cdp.send("Browser.getVersion");
    const extension = await cdp.send("Extensions.loadUnpacked", { path: ROOT });
    const page = sessionState
      ? await openPageWithSession(cdp, TARGET_URL, cookies, sessionState)
      : await openProfile(cdp, TARGET_URL, cookies);
    const context = await waitForExtensionContext(cdp, page.sessionId);

    await waitForEvaluate(cdp, page.sessionId, "Boolean(window.PolymarketSportsFilter)", 30000, context.id);
    await setDefaultSports(cdp, page.sessionId, context.id);
    await waitForEvaluate(cdp, page.sessionId, `Boolean(document.getElementById("psf-style"))`, 30000);
    await sleep(1500);

    const status = await collectStatus(cdp, page.sessionId, context.id);
    const findNext = FIND_NEXT_CHECK
      ? await evaluate(
          cdp,
          page.sessionId,
          `window.PolymarketSportsFilterRuntime.findNextMatchingRow()`,
          45000,
          context.id
        )
      : null;
    const statusAfterFindNext = FIND_NEXT_CHECK ? await collectStatus(cdp, page.sessionId, context.id) : null;

    console.log(
      JSON.stringify(
        {
          targetUrl: TARGET_URL,
          profileDir: PROFILE_DIR,
          extensionId: extension.id,
          cookieJsonPath: COOKIE_JSON_PATH || null,
          cookiesImported: cookies.length,
          sessionJsonPath: sessionState ? SESSION_JSON_PATH : null,
          status,
          findNext,
          statusAfterFindNext,
        },
        null,
        2
      )
    );

    if (CHECK_MODE) {
      child.kill();
      return;
    }

    console.log("Chrome is open with the unpacked extension loaded. Press Ctrl+C here to close it.");
    setInterval(() => {}, 2 ** 31 - 1);
  } catch (error) {
    if (child && !child.killed) {
      child.kill();
    }

    throw error;
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
