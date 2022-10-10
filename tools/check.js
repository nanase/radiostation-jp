'use strict';

// to run this script: node tools/check.js

const fs = require('fs');
const path = require('path');

function showStats(data) {
  console.info('Statistics:')
  console.info(`  Radio Station Studios  ${data.radioStations.length}`);

  const stations = data.radioStations.flatMap(s => s.stations);
  console.info(`    Primary Stations     ${stations.filter(s => s.type === 'primary').length}`);
  console.info(`    Relay Stations       ${stations.filter(s => s.type === 'relay').length}`);
  console.info(`    Reserve Stations     ${stations.filter(s => s.type === 'reserve').length}`);
  console.info(`    Stations Total       ${stations.length}`);

  console.info(`  Addresses              ${Object.keys(data.addresses).length}`);
}

function checkAddress(data) {
  const studios = data.radioStations.map(s => s.studio.addressId);
  const stations = data.radioStations.flatMap(s => s.stations).map(s => s.addressId);
  const stationAddressIds = [...new Set(studios), ...new Set(stations)];

  for (const stationAddressId of stationAddressIds) {
    if (!data.addresses[stationAddressId]) {
      warn(`'${stationAddressId}' is used, but not defined.`);
    }
  }

  for (const addressId of Object.keys(data.addresses)) {
    if (stationAddressIds.indexOf(addressId) === -1) {
      warn(`'${addressId}' is defined, but not used.`);
    }
  }
}

function warn(message) {
  console.warn(`\x1b[33m${message}\x1b[0m`);
}

(function doCheck() {
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../stations.json')));

  showStats(data);
  checkAddress(data);
})();
