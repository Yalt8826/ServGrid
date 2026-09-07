#!/usr/bin/env node
/** Fixture: always exits 1 with the marker the probe asserts on. */
console.error('fail-check: deliberate failure (fixture)');
process.exit(1);
