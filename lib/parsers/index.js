'use strict';

const LandWatchParser = require('./landwatch');
const LandComParser = require('./landcom');
const LandAndFarmParser = require('./landfarm');
const LandsOfAmericaParser = require('./landsofamerica');
const LivingTheDreamParser = require('./livingthedream');
const WhitetailParser = require('./whitetail');
const MossyOakParser = require('./mossyoak');

const parsers = {
  landwatch: () => new LandWatchParser(),
  landcom: () => new LandComParser(),
  landfarm: () => new LandAndFarmParser(),
  landsofamerica: () => new LandsOfAmericaParser(),
  livingthedream: () => new LivingTheDreamParser(),
  whitetail: () => new WhitetailParser(),
  mossyoak: () => new MossyOakParser(),
};

function getEnabledParsers(siteSettings) {
  return Object.entries(siteSettings)
    .filter(([_, config]) => config.enabled)
    .map(([name]) => {
      if (!parsers[name]) {
        console.warn(`Unknown parser: ${name}`);
        return null;
      }
      return parsers[name]();
    })
    .filter(Boolean);
}

module.exports = { parsers, getEnabledParsers };
