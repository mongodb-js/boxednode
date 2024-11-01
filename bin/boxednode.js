#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
'use strict';
const { compileJSFileAsBinary } = require('..');
const argv = require('yargs')
  .option('clean', {
    alias: 'c', type: 'boolean', desc: 'Clean up temporary directory after success'
  })
  .option('source', {
    alias: 's', type: 'string', demandOption: true, desc: 'Source .js file'
  })
  .option('target', {
    alias: 't', type: 'string', demandOption: true, desc: 'Target executable file'
  })
  .option('node-version', {
    alias: 'n', type: 'string', desc: 'Node.js version or semver version range or .tar.gz file url', default: '*'
  })
  .option('configure-args', {
    alias: 'C', type: 'string', desc: 'Extra ./configure or vcbuild arguments, comma-separated'
  })
  .option('make-args', {
    alias: 'M', type: 'string', desc: 'Extra make or vcbuild arguments, comma-separated'
  })
  .option('tmpdir', {
    type: 'string', desc: 'Temporary directory for compiling Node.js source'
  })
  .option('namespace', {
    alias: 'N', type: 'string', desc: 'Module identifier for the generated binary'
  })
  .option('use-legacy-default-uv-loop', {
    type: 'boolean', desc: 'Use the global singleton libuv event loop rather than a separate local one'
  })
  .option('use-code-cache', {
    alias: 'H', type: 'boolean', desc: 'Use Node.js code cache support to speed up startup'
  })
  .option('use-node-snapshot', {
    alias: 'S', type: 'boolean', desc: 'Use experimental Node.js snapshot support'
  })
  .example('$0 -s myProject.js -t myProject.exe -n ^14.0.0',
    'Create myProject.exe from myProject.js using Node.js v14')
  .help()
  .argv;

(async function main () {
  try {
    await compileJSFileAsBinary({
      nodeVersionRange: argv.n,
      sourceFile: argv.s,
      targetFile: argv.t,
      tmpdir: argv.tmpdir,
      clean: argv.c,
      configureArgs: (argv.C || '').split(',').filter(Boolean),
      makeArgs: (argv.M || '').split(',').filter(Boolean),
      namespace: argv.N,
      useLegacyDefaultUvLoop: argv.useLegacyDefaultUvLoop,
      useCodeCache: argv.H,
      useNodeSnapshot: argv.S,
      compressBlobs: argv.Z
    });
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();
