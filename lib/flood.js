'use strict';

const fetch = require('node-fetch');

/**
 * FEMA flood-zone lookup via the free National Flood Hazard Layer (NFHL)
 * ArcGIS REST API. Layer 28 is "Flood Hazard Zones" — querying it with a
 * point returns the FLD_ZONE the point falls in.
 *
 * Zone meanings (roughly):
 *   A / AE / AH / AO / AR / A99  — 1%-annual-chance floodplain (HIGH RISK)
 *   V / VE                        — coastal high hazard (HIGH RISK)
 *   X (shaded)                    — 0.2% annual chance (moderate)
 *   X (unshaded) / not mapped     — minimal hazard
 */
const NFHL_QUERY_URL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';
const REQUEST_TIMEOUT_MS = 15000;

function isHighRiskZone(zone) {
  if (!zone) return false;
  return /^(A|V)/i.test(String(zone).trim());
}

/**
 * Parse a "lat, lng" coordinate string (the Airtable Coordinate field format).
 * Returns { lat, lng } or null.
 */
function parseCoordinateString(text) {
  if (!text) return null;
  const match = String(text).match(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 24 || lat > 50 || lng > -65 || lng < -125) return null; // Continental US bounds
  return { lat, lng };
}

/**
 * Turn an NFHL query response into { zone, subtype, isHighRisk, mapped }.
 * No intersecting flood polygon → zone NONE (area not in a mapped hazard zone).
 * Malformed response → null (treat as "check unavailable", not "safe").
 */
function parseFloodResponse(data) {
  if (!data || !Array.isArray(data.features)) return null;
  if (data.features.length === 0) {
    return { zone: 'NONE', subtype: null, isHighRisk: false, mapped: false };
  }
  let best = null;
  for (const feature of data.features) {
    const attrs = feature && feature.attributes;
    const zone = attrs && (attrs.FLD_ZONE || attrs.fld_zone);
    if (!zone) continue;
    const candidate = {
      zone: String(zone).toUpperCase(),
      subtype: (attrs.ZONE_SUBTY || attrs.zone_subty || null) || null,
      isHighRisk: isHighRiskZone(zone),
      mapped: true,
    };
    // Prefer the highest-risk zone when multiple polygons intersect the point
    if (!best || (candidate.isHighRisk && !best.isHighRisk)) best = candidate;
  }
  return best;
}

/**
 * Query FEMA for the flood zone at a point. Returns the parseFloodResponse
 * shape, or null when the lookup fails (network, API down, bad response) —
 * callers should treat null as "unknown", never as "no flood risk".
 */
async function getFloodZone(lat, lng) {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'FLD_ZONE,ZONE_SUBTY',
    returnGeometry: 'false',
    f: 'json',
  });

  try {
    const response = await fetch(`${NFHL_QUERY_URL}?${params.toString()}`, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) {
      console.warn(`[Flood] NFHL query failed: HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (data && data.error) {
      console.warn(`[Flood] NFHL query error: ${data.error.message || 'unknown'}`);
      return null;
    }
    return parseFloodResponse(data);
  } catch (err) {
    console.warn(`[Flood] NFHL lookup failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  getFloodZone,
  parseFloodResponse,
  parseCoordinateString,
  isHighRiskZone,
};
