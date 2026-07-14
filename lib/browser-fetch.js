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

function isEnabled() {
  if (process.env.SCRAPER_BROWSER_FALLBACK === 'false') return false;
  return playwright !== null && !launchFailed;
}

function reasonUnavailable() {
  return unavailableReason;
}

/**
 * Launch candidates, most specific first:
 *  1. SCRAPER_BROWSER_PATH from .env
 *  2. The machine's installed Google Chrome (playwright 'chrome' channel)
 *  3. The default macOS Chrome path (channel lookup can miss user installs)
 *  4. A playwright-managed Chromium if one was ever installed
 */
function launchCandidates() {
  const headless = true;
  const candidates = [];
  if (process.env.SCRAPER_BROWSER_PATH) {
    candidates.push({ headless, executablePath: process.env.SCRAPER_BROWSER_PATH });
  }
  candidates.push({ headless, channel: 'chrome' });
  candidates.push({ headless, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  candidates.push({ headless });
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
    viewport: { width: 1440, height: 900 },
  });
  return context;
}

/**
 * Fetch a page through the real browser. Returns the rendered HTML.
 * Throws with err.status set when the navigation itself was refused.
 */
async function fetchPageWithBrowser(url, { timeoutMs = 45000 } = {}) {
  const ctx = await getContext();
  if (!ctx) {
    const err = new Error(unavailableReason || 'browser fallback unavailable');
    err.browserUnavailable = true;
    throw err;
  }

  const page = await ctx.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Give client-rendered listing grids and bot-checks a moment to settle
    await page.waitForTimeout(2500);
    const status = response ? response.status() : 0;
    const html = await page.content();
    if (status >= 400) {
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

module.exports = { isEnabled, reasonUnavailable, fetchPageWithBrowser, warnUnavailableOnce, closeBrowser };
