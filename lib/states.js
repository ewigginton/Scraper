'use strict';

const STATE_ABBREV_TO_FULL = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming',
};

const STATE_FULL_TO_ABBREV = {};
for (const [abbr, full] of Object.entries(STATE_ABBREV_TO_FULL)) {
  STATE_FULL_TO_ABBREV[full.toLowerCase()] = abbr;
}

function stateFullName(abbr) {
  return STATE_ABBREV_TO_FULL[abbr.toUpperCase()] || abbr;
}

function stateAbbrev(fullName) {
  return STATE_FULL_TO_ABBREV[fullName.toLowerCase().trim()] || fullName.trim().toUpperCase();
}

function stateSlugLower(abbr) {
  const full = stateFullName(abbr);
  return full.toLowerCase().replace(/\s+/g, '-');
}

function stateSlugTitle(abbr) {
  const full = stateFullName(abbr);
  return full.replace(/\s+/g, '-');
}

module.exports = {
  STATE_ABBREV_TO_FULL,
  STATE_FULL_TO_ABBREV,
  stateFullName,
  stateAbbrev,
  stateSlugLower,
  stateSlugTitle,
};
