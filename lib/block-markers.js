'use strict';

// Signatures of a page that is NOT a listings page, so the scraper must stop
// fetching that series instead of recording a valid-looking empty result.
// Shared by the parsers (base-parser), the browser fallback (which needs them
// to know when a challenge has finished auto-solving) and the live probe
// (scripts/test-browser-fallback.js).
//
// Two different things live in this one list, and the difference matters when
// reading a report:
//
//  1. Bot-management challenge pages. Imperva/Cloudflare/PerimeterX/Kasada and
//     friends serve these with HTTP 200, so a "successful" fetch can still be a
//     block. These are the markers from 'just a moment' down.
//
//  2. CoStar-network error/challenge interstitials, matched by their title TAIL
//     ('<brand> / <http status>'). The captured example is
//     test/fixtures/blocked/landwatch-challenge-400.html, title
//     "LandWatch / 400".
//
// HONESTY NOTE about (2): a hit is NOT proof that this IP is being blocked.
// Emma loaded that same queued LandWatch URL in her own browser and got a
// styled "Oops! We couldn't find this page", so the captured page is most
// likely a BAD-URL error page — the underlying cause of that capture was a
// stale queued URL, not a bot wall. It is still classified here on purpose:
// such a page must never count as a valid empty results page, and for the
// bot-wall-sensitive CoStar sources abandoning the site on one is
// conservative-safe (worst case we skip a county series for a night). The
// title-tail entries cover only titles ENDING in "/ <code>" for the codes
// listed; other error shapes (a plain 404 body, a differently worded title)
// are not caught here and are not claimed to be. "/ 500" is deliberately
// absent: a transient server error already retries by HTTP status, and turning
// one into a "blocked" verdict would abandon a bot-wall-sensitive site for the
// night over the site's own hiccup. Verified against every
// real-page fixture in test/fixtures/ — none of them matches (the sweep is
// pinned in test/bot-wall-sensitivity.test.js).
const BLOCK_MARKERS = [
  // (1) bot-management challenge pages
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
  // (2) CoStar-network error/challenge interstitials, by title tail
  '/ 400</title>',
  '/ 403</title>',
  '/ 404</title>',
  '/ 429</title>',
  '/ 503</title>',
];

function isBlockedHtml(html) {
  if (!html) return false;
  const sample = html.slice(0, 20000).toLowerCase();
  return BLOCK_MARKERS.some(marker => sample.includes(marker));
}

module.exports = { BLOCK_MARKERS, isBlockedHtml };
