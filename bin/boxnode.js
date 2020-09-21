/* eslint-disable @typescript-eslint/no-var-requires */
'use strict';
const { compileJSFileAsBinary } = require('..');
const argv = require('yargs')
  .option('clean', {
    alias: 'c', type: 'boolean', desc: 'Clean up temporary directory'
  })
  .option('source', {
    alias: 's', type: 'string', demandOption: true, desc: 'Source .js file'
  })
  .option('target', {
    alias: 't', type: 'string', demandOption: true, desc: 'Target executable file'
  })
  .option('node-version', {
    alias: 'n', type: 'string', desc: 'Node.js version or semver version range', default: '*'
  })
  .option('tmpdir', {
    type: 'string', desc: 'Temporary directory for compiling Node.js source'
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
      clean: argv.c
    });
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();
