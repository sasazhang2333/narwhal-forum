#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2))
  .then((code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write('✗ ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exitCode = 1;
  });
