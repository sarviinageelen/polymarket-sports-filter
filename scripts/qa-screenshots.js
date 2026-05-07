const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(ROOT, ".qa", "screenshots");
const TARGET_URL = "https://polymarket.com/@takumi-crypto-81";
const VIEWPORT = { width: 1400, height: 1000 };

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
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
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

function launchChrome(profileName) {
  const profileDir = path.join(os.tmpdir(), profileName);
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  return childProcess.spawn(
    findChrome(),
    [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      windowsHide: false,
    }
  );
}

async function evaluate(cdp, sessionId, expression, timeout = 10000) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      awaitPromise: true,
      expression,
      returnByValue: true,
      timeout,
    },
    sessionId
  );

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }

  return result.result.value;
}

async function waitFor(cdp, sessionId, expression, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await evaluate(cdp, sessionId, expression, 5000);

    if (lastValue) {
      return lastValue;
    }

    await sleep(750);
  }

  throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(lastValue)}`);
}

async function openProfile(cdp) {
  const target = await cdp.send("Target.createTarget", { url: TARGET_URL });
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
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    },
    sessionId
  );

  await waitFor(
    cdp,
    sessionId,
    `document.readyState === "complete" && /Positions|Activity/.test(document.body.innerText)`
  );
  await sleep(3000);

  return sessionId;
}

async function saveScreenshot(cdp, sessionId, filename) {
  const shot = await cdp.send(
    "Page.captureScreenshot",
    {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
    },
    sessionId
  );

  fs.writeFileSync(path.join(OUT_DIR, filename), Buffer.from(shot.data, "base64"));
}

async function captureRun({ withExtension }) {
  const child = launchChrome(withExtension ? "psf-after-profile" : "psf-before-profile");
  const cdp = new PipeCdp(child);

  try {
    await cdp.send("Browser.getVersion");

    let extensionId = null;

    if (withExtension) {
      const extension = await cdp.send("Extensions.loadUnpacked", { path: ROOT });
      extensionId = extension.id;
    }

    const sessionId = await openProfile(cdp);

    if (withExtension) {
      await waitFor(cdp, sessionId, `Boolean(document.getElementById("psf-style"))`);
      await sleep(2000);
    }

    await saveScreenshot(cdp, sessionId, withExtension ? "after-extension.png" : "before-extension.png");

    const debug = await evaluate(
      cdp,
      sessionId,
      `(() => {
        function clean(text) {
          return String(text || "").replace(/\\s+/g, " ").trim();
        }

        function box(element) {
          const rect = element.getBoundingClientRect();
          return {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        }

        function visible(element) {
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
        }

        const hidden = [...document.querySelectorAll(".psf-hidden-row")].map((element, index) => ({
          index,
          tag: element.tagName.toLowerCase(),
          text: clean(element.textContent).slice(0, 500),
          box: box(element),
          links: [...element.querySelectorAll("a[href*='/event/'], a[href*='/market/']")].map((link) => ({
            text: clean(link.textContent).slice(0, 120),
            href: link.href
          })).slice(0, 5),
          ancestorText: clean(element.parentElement && element.parentElement.textContent).slice(0, 500),
          parentTag: element.parentElement && element.parentElement.tagName.toLowerCase()
        }));

        const summary = {
          title: document.title,
          url: location.href,
          extensionActive: Boolean(document.getElementById("psf-style")),
          bodyTextStart: clean(document.body.innerText).slice(0, 1500),
          profileNameVisible: [...document.querySelectorAll("body *")].some((element) => visible(element) && /Takumi-Crypto-81/i.test(clean(element.textContent))),
          positionsValueVisible: [...document.querySelectorAll("body *")].some((element) => visible(element) && /Positions Value/i.test(clean(element.textContent))),
          profitLossVisible: [...document.querySelectorAll("body *")].some((element) => visible(element) && /Profit\\/Loss/i.test(clean(element.textContent))),
          hiddenCount: hidden.length,
          hidden
        };

        return summary;
      })()`
    );

    fs.writeFileSync(
      path.join(OUT_DIR, withExtension ? "after-extension-debug.json" : "before-extension-debug.json"),
      JSON.stringify({ extensionId, ...debug }, null, 2)
    );

    return { extensionId, ...debug };
  } finally {
    child.kill();
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const before = await captureRun({ withExtension: false });
  const after = await captureRun({ withExtension: true });

  console.log(
    JSON.stringify(
      {
        screenshots: {
          before: path.join(OUT_DIR, "before-extension.png"),
          after: path.join(OUT_DIR, "after-extension.png"),
        },
        before: {
          profileNameVisible: before.profileNameVisible,
          positionsValueVisible: before.positionsValueVisible,
          profitLossVisible: before.profitLossVisible,
          hiddenCount: before.hiddenCount,
        },
        after: {
          extensionId: after.extensionId,
          profileNameVisible: after.profileNameVisible,
          positionsValueVisible: after.positionsValueVisible,
          profitLossVisible: after.profitLossVisible,
          hiddenCount: after.hiddenCount,
          firstHidden: after.hidden.slice(0, 5),
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
