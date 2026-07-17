'use strict';

/**
 * Browser-based fetch fallback for bot-blocked sources.
 *
 * LandWatch / Land.com / LandAndFarm (all CoStar-network sites) fingerprint
 * plain HTTP clients — node-fetch's TLS signature gets an HTTP 403 no matter
 * what headers it sends. A real browser engine passes those checks from the
 * production Mac's residential IP.
 *
 * playwright-core is an optionalDependency (a few MB, downloads no browser).
 * The launcher looks for a real Chrome/Chromium on the machine. When either
 * piece is missing the scraper logs one line and keeps the plain-fetch
 * behavior — nothing breaks.
 *
 * Disable with SCRAPER_BROWSER_FALLBACK=false (the CI dry-run workflow does).
 */

const fs = require('fs');
const { isBlockedHtml } = require('./block-markers');

let playwright = null;
let unavailableReason = null;
try {
  playwright = require('playwright-core');
} catch (_) {
  unavailableReason = "playwright-core is not installed — run 'npm install' to enable browser fallback";
}

let browser = null;
let context = null;
let launchFailed = false;
let warnedUnavailable = false;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Statuses bot walls answer while their challenge runs (CoStar-network sites
// serve 400 as well as the usual 403/429/503). A real browser may still solve
// the challenge and render real content, so these route to the browser
// fallback; genuine content statuses (404/410/...) do not.
function isBotWallStatus(status) {
  return status === 400 || status === 403 || status === 429 || status === 503;
}

function isEnabled() {
  if (process.env.SCRAPER_BROWSER_FALLBACK === 'false') return false;
  return playwright !== null && !launchFailed;
}

function reasonUnavailable() {
  return unavailableReason;
}

// Chrome/Chromium locations on the platforms this runs on: the production
// Mac, Linux CI boxes, and sandboxes with a pre-provisioned Chromium.
const COMMON_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/opt/pw-browsers/chromium',
];

/**
 * Launch candidates, most specific first:
 *  1. SCRAPER_BROWSER_PATH from .env
 *  2. The machine's installed Google Chrome (playwright 'chrome' channel)
 *  3. Any Chrome/Chromium binary found at a well-known path
 *  4. A playwright-managed Chromium if one was ever installed
 */
function launchCandidates() {
  // SCRAPER_BROWSER_HEADED=true runs a visible Chrome — the strongest
  // counter to headless-detection on a machine where windows are acceptable
  // (the always-on production Mac at 2 AM qualifies)
  const headless = process.env.SCRAPER_BROWSER_HEADED !== 'true';
  // Chromium exposes navigator.webdriver=true under automation — the single
  // most-checked bot signal. This flag removes it.
  const args = ['--disable-blink-features=AutomationControlled'];
  const candidates = [];
  if (process.env.SCRAPER_BROWSER_PATH) {
    candidates.push({ headless, args, executablePath: process.env.SCRAPER_BROWSER_PATH });
  }
  candidates.push({ headless, args, channel: 'chrome' });
  for (const executablePath of COMMON_BROWSER_PATHS) {
    if (fs.existsSync(executablePath)) {
      candidates.push({ headless, args, executablePath });
    }
  }
  candidates.push({ headless, args });
  return candidates;
}

async function getContext() {
  if (context) return context;
  if (!playwright || launchFailed) return null;

  const errors = [];
  for (const options of launchCandidates()) {
    try {
      browser = await playwright.chromium.launch(options);
      break;
    } catch (err) {
      errors.push(err.message.split('\n')[0]);
    }
  }
  if (!browser) {
    launchFailed = true;
    unavailableReason = `no usable Chrome/Chromium found for browser fallback (set SCRAPER_BROWSER_PATH in .env). Tried: ${errors.join(' | ')}`;
    return null;
  }

  context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    viewport: { width: 1440, height: 900 },
  });
  // Belt and braces for engines where the launch flag doesn't apply
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

/**
 * Fetch a page through the real browser. Returns the rendered HTML.
 * Throws with err.status set when the navigation itself was refused.
 *
 * Challenge pages (Imperva/Kasada/PerimeterX) usually auto-solve in a few
 * seconds and then swap in the real content, so instead of one fixed pause
 * this polls the DOM until the challenge markers disappear (or the wait
 * budget runs out — the caller's block detection then reports honestly).
 */
async function fetchPageWithBrowser(url, { timeoutMs, challengeWaitMs } = {}) {
  const navTimeout = timeoutMs
    || Number(process.env.SCRAPER_BROWSER_TIMEOUT_MS) || 60000;
  const challengeBudget = challengeWaitMs
    || Number(process.env.SCRAPER_BROWSER_CHALLENGE_WAIT_MS) || 25000;

  const ctx = await getContext();
  if (!ctx) {
    const err = new Error(unavailableReason || 'browser fallback unavailable');
    err.browserUnavailable = true;
    throw err;
  }

  const page = await ctx.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    const status = response ? response.status() : 0;

    // Let client-rendered grids and bot-checks settle, then poll while the
    // page still looks like a challenge — many walls solve and navigate to
    // the real page within seconds
    await page.waitForTimeout(2500);
    let html = await page.content();
    const deadline = Date.now() + challengeBudget;
    while (isBlockedHtml(html) && Date.now() < deadline) {
      await page.waitForTimeout(1500);
      html = await page.content();
    }

    // Bot walls answer 400/403/429/503 while their challenge runs; if the
    // final DOM is no longer a challenge page, the wall solved itself and
    // rendered real content — return it and let the caller's parse decide.
    // Genuine content statuses (404/410/...) always throw so removed-listing
    // detection keeps working.
    if (status >= 400 && (!isBotWallStatus(status) || isBlockedHtml(html))) {
      const err = new Error(`HTTP ${status} for ${url} (via browser)`);
      err.status = status;
      throw err;
    }
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Warn once per run when a fallback was wanted but is unavailable. */
function warnUnavailableOnce(siteName) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(`[${siteName}] Browser fallback unavailable: ${unavailableReason}`);
}

async function closeBrowser() {
  const b = browser;
  browser = null;
  context = null;
  if (b) {
    await b.close().catch(() => {});
  }
}

module.exports = { isEnabled, reasonUnavailable, fetchPageWithBrowser, warnUnavailableOnce, closeBrowser, isBotWallStatus };
