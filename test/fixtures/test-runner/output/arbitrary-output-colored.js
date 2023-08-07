'use strict';
const common = require('../../../common');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fixtures = require('../../../common/fixtures');

(async function run() {
  const test = fixtures.path('test-runner/output/arbitrary-output-colored-1.js');
  const reset = fixtures.path('test-runner/output/reset-color-depth.js');
  await once(spawn(process.execPath, ['-r', reset, '--test', test], { stdio: 'inherit', env: { ELECTRON_RUN_AS_NODE: 1 }}), 'exit');
  await once(spawn(process.execPath, ['-r', reset, '--test', '--test-reporter', 'tap', test], { stdio: 'inherit', env: { ELECTRON_RUN_AS_NODE: 1 }  }), 'exit');
})().then(common.mustCall());
