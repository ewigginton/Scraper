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

function isBlockedHtml(html) {
  if (!html) return false;
  const sample = html.slice(0, 20000).toLowerCase();
  return BLOCK_MARKERS.some(marker => sample.includes(marker));
}

module.exports = { BLOCK_MARKERS, isBlockedHtml };
