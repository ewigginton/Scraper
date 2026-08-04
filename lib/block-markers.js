'use strict';

// Bot-management vendors (Imperva/Cloudflare/PerimeterX/Kasada/etc.) serve
// their challenge pages with HTTP 200, so a "successful" fetch can still be
// a block. These markers distinguish a challenge from a real results page.
// Shared by the parsers (base-parser) and the browser fallback, which needs
// them to know when a challenge has finished auto-solving.
const BLOCK_MARKERS = [
  'just a moment',
  'access denied',
  'incapsula',
  '_incapsula_resource',
  'perimeterx',
  'px-captcha',
  'cf-browser-verification',
  'cf-challenge',
  'attention required',
  'request unsuccessful',
  'verify you are a human',
  'are you a robot',
  'enable javascript and cookies to continue',
];

// CoStar-network sites (LandWatch/Land.com/LandAndFarm) answer rejected
// requests with their React app rendering an error route whose title is
// "<SiteName> / <status>" (e.g. "LandWatch / 400") — a fully-rendered page
// with nav and footer but no content. Proven by the captured evidence page
// www.landwatch.com-kentucky-wayne-county-...-8492863d.html, whose shell
// tricked the pipeline twice: the browser fallback returned it as real
// content (200-looking DOM), and the zero-parse path then misreported 122
// pages of it as "markup drift" in the 2026-08-04 nightly report.
const ERROR_SHELL_TITLE_RE = /<title>[^<]*\/\s*[45]\d\d\s*<\/title>/i;

// An error shell is terminal — unlike a challenge page it will never
// auto-solve into real content, so the browser fallback's challenge-wait
// loop must not poll on it.
function isErrorShellHtml(html) {
  if (!html) return false;
  return ERROR_SHELL_TITLE_RE.test(html.slice(0, 20000));
}

function isBlockedHtml(html) {
  if (!html) return false;
  const sample = html.slice(0, 20000);
  const lower = sample.toLowerCase();
  if (BLOCK_MARKERS.some(marker => lower.includes(marker))) return true;
  return ERROR_SHELL_TITLE_RE.test(sample);
}

module.exports = { BLOCK_MARKERS, isBlockedHtml, isErrorShellHtml };
