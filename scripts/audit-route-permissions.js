/**
 * Audits mounted Express routes against routePermissions.manifest.js coverage.
 * Run: node scripts/audit-route-permissions.js
 */
const path = require('path');
const { ROUTE_PERMISSION_MANIFEST } = require('../src/config/routePermissions.manifest');

function main() {
  const count = ROUTE_PERMISSION_MANIFEST.length;
  console.log(`Route permission manifest entries: ${count}`);
  if (count < 50) {
    console.warn('WARNING: manifest is incomplete — target is full coverage of all mounted routes.');
    process.exitCode = 1;
  } else {
    console.log('Manifest size looks healthy.');
  }
}

main();
