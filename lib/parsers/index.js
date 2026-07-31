'use strict';

const LandWatchParser = require('./landwatch');
const LandComParser = require('./landcom');
const LandAndFarmParser = require('./landfarm');
const LandsOfAmericaParser = require('./landsofamerica');
const LivingTheDreamParser = require('./livingthedream');
const WhitetailParser = require('./whitetail');
const MossyOakParser = require('./mossyoak');
const MidwestLandGroupParser = require('./midwestlandgroup');
const LandflipParser = require('./landflip');
const NationalLandRealtyParser = require('./nationalland');
const TuttLandParser = require('./tuttland');

const parsers = {
  landwatch: () => new LandWatchParser(),
  landcom: () => new LandComParser(),
  landfarm: () => new LandAndFarmParser(),
  landsofamerica: () => new LandsOfAmericaParser(),
  livingthedream: () => new LivingTheDreamParser(),
  whitetail: () => new WhitetailParser(),
  mossyoak: () => new MossyOakParser(),
  midwestlandgroup: () => new MidwestLandGroupParser(),
  landflip: () => new LandflipParser(),
  nationalland: () => new NationalLandRealtyParser(),
  tuttland: () => new TuttLandParser(),
};

function getEnabledParsers(siteSettings) {
  return Object.entries(siteSettings)
    .filter(([_, config]) => config.enabled)
    .map(([name, config]) => {
      if (!parsers[name]) {
        console.warn(`Unknown parser: ${name}`);
        return null;
      }
      const parser = parsers[name]();
      // Site config key and its optional county-rotation factor (see
      // lib/county-rotation.js) travel with the instance so the orchestrator
      // can size each site's nightly county subset.
      parser.siteKey = name;
      parser.countyRotation = config.countyRotation;
      // Bot-wall sensitivity profile (the CoStar-network sites): one blocked
      // page abandons the site for the night, per-request delays double, and
      // the orchestrator queues no same-night retry. Coerced to a real boolean
      // so a missing key reads false rather than undefined.
      parser.botWallSensitive = Boolean(config.botWallSensitive);
      return parser;
    })
    .filter(Boolean);
}

module.exports = { parsers, getEnabledParsers };
