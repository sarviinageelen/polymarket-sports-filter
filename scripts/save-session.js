const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_DIR = process.env.PSF_OPEN_PROFILE_DIR || path.join(ROOT, ".qa", "manual-polymarket-profile");
const OUTPUT_PATH = process.env.POLYMARKET_SESSION_JSON || path.join(ROOT, ".qa", "polymarket-session.json");
const TARGET_URL =
  process.argv.find((arg) => /^https?:\/\//i.test(arg)) ||
  process.env.PSF_PROFILE_URL ||
  "https://polymarket.com/profile/0x03e4bf005d66269e6eec3297346e48cca836c185";
const ORIGIN = "https://polymarket.com";

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
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error(`Profile directory does not exist: ${PROFILE_DIR}`);
  }

  return childProcess.spawn(
    findChrome(),
    [
      "--remote-debugging-pipe",
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
}

async function evaluate(cdp, sessionId, expression, timeout = 10000) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { awaitPromise: true, expression, returnByValue: true, timeout },
    sessionId
  );

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }

  return result.result.value;
}

async function waitForEvaluate(cdp, sessionId, expression, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await evaluate(cdp, sessionId, expression, 5000);

    if (lastValue) {
      return lastValue;
    }

    await sleep(750);
  }

  throw new Error(`Timed out waiting for ${expression}; last value=${JSON.stringify(lastValue)}`);
}

async function collectStorage(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const readStorage = (storage) => {
        const entries = {};
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          entries[key] = storage.getItem(key);
        }
        return entries;
      };

      return {
        localStorage: readStorage(localStorage),
        loggedOut: /\\bLog In\\b|\\bSign Up\\b/.test(document.body.innerText),
        hasDeposit: /\\bDeposit\\b/.test(document.body.innerText),
        sessionStorage: readStorage(sessionStorage),
        url: location.href,
      };
    })()`
  );
}

function toPortableCookie(cookie) {
  return {
    domain: cookie.domain,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    session: cookie.session,
    value: cookie.value,
  };
}

async function run() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  const child = launchChrome();
  const cdp = new PipeCdp(child);

  try {
    await cdp.send("Browser.getVersion");
    const target = await cdp.send("Target.createTarget", { url: TARGET_URL });
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;

    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await waitForEvaluate(
      cdp,
      sessionId,
      `document.readyState === "complete" && /Polymarket|Deposit|Log In|Sign Up/.test(document.body.innerText)`
    );
    await sleep(3000);

    const storage = await collectStorage(cdp, sessionId);

    if (storage.loggedOut || !storage.hasDeposit) {
      throw new Error("Polymarket is not logged in in this profile. Log in first, then rerun npm run save:session.");
    }

    const cookieResult = await cdp.send("Network.getCookies", { urls: [ORIGIN] }, sessionId);
    const cookies = cookieResult.cookies
      .filter((cookie) => cookie.domain === "polymarket.com" || cookie.domain.endsWith(".polymarket.com"))
      .map(toPortableCookie);
    const session = {
      cookies,
      exportedAt: new Date().toISOString(),
      localStorage: storage.localStorage,
      origin: ORIGIN,
      profileDir: PROFILE_DIR,
      sessionStorage: storage.sessionStorage,
      targetUrl: TARGET_URL,
    };

    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(session, null, 2)}\n`);

    console.log(
      JSON.stringify(
        {
          cookies: cookies.length,
          hasDeposit: storage.hasDeposit,
          localStorageKeys: Object.keys(storage.localStorage).length,
          outputPath: OUTPUT_PATH,
          sessionStorageKeys: Object.keys(storage.sessionStorage).length,
          url: storage.url,
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
