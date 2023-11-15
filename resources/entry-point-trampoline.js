'use strict';
const Module = require('module');
const vm = require('vm');
const v8 = require('v8');
const path = require('path');
const assert = require('assert');
const {
  requireMappings,
  enableBindingsPatch
} = REPLACE_WITH_BOXEDNODE_CONFIG;
const hydatedRequireMappings =
  requireMappings.map(([re, reFlags, linked]) => [new RegExp(re, reFlags), linked]);

if (process.argv[2] === '--') process.argv.splice(2, 1);

if (enableBindingsPatch) {
  // Hack around various deficiencies in https://github.com/TooTallNate/node-bindings
  const fs = require('fs');
  const origFsAccessSync = fs.accessSync;
  fs.accessSync = (filename, ...args) => {
    if (path.basename(filename) === 'node_modules' &&
        path.join(path.dirname(filename), '..') === path.dirname(filename)) {
      return;
    }
    return origFsAccessSync.call(fs, filename, ...args);
  };

  let epst = Error.prepareStackTrace;
  Object.defineProperty(Error, 'prepareStackTrace', {
    configurable: true,
    get() {
      return epst;
    },
    set(v) {
      if (typeof v !== 'function') {
        epst = v;
        return;
      }
      epst = function(error, stack) {
        stack = stack.map(entry => {
          if (!entry) return entry;
          const origGetFileName = entry.getFileName;
          Object.defineProperty(entry, 'getFileName', {
            configurable: true,
            value: function(...args) {
              return origGetFileName.call(this, ...args) || '';
            }
          });
          return entry;
        })
        return v.call(this, error, stack);
      };
    }
  });
}

const outerRequire = require;
module.exports = (src, codeCacheMode, codeCache) => {
  const __filename = process.execPath;
  const __dirname = path.dirname(process.execPath);
  let innerRequire;
  const exports = {};
  const isBuildingSnapshot = () => !!v8?.startupSnapshot?.isBuildingSnapshot();
  const usesSnapshot = isBuildingSnapshot();

  if (usesSnapshot) {
    innerRequire = outerRequire; // Node.js snapshots currently do not support userland require()
    v8.startupSnapshot.addDeserializeCallback(() => {
      if (process.argv[1] === '--boxednode-snapshot-argv-fixup') {
        process.argv.splice(1, 1, process.execPath);
      }
    });
  } else {
    innerRequire = Module.createRequire(__filename);
  }

  function require(module) {
    for (const [ re, linked ] of hydatedRequireMappings) {
      try {
        if (re.test(module))
          return process._linkedBinding(linked);
      } catch {}
    }
    return innerRequire(module);
  }
  Object.defineProperties(require, Object.getOwnPropertyDescriptors(innerRequire));
  Object.setPrototypeOf(require, Object.getPrototypeOf(innerRequire));

  process.argv.unshift(__filename);
  process.boxednode = { usesSnapshot };

  const module = {
    exports,
    children: [],
    filename: __filename,
    id: __filename,
    path: __dirname,
    require
  };

  let mainFunction;
  if (usesSnapshot) {
    mainFunction = eval(`(function(__filename, __dirname, require, exports, module) {\n${src}\n})`);
  } else {
    mainFunction = vm.compileFunction(src, [
      '__filename', '__dirname', 'require', 'exports', 'module'
    ], {
      filename: __filename,
      cachedData: codeCache.length > 0 ? codeCache : undefined,
      produceCachedData: codeCacheMode === 'generate'
    });
    if (codeCacheMode === 'generate') {
      assert.strictEqual(mainFunction.cachedDataProduced, true);
      require('fs').writeFileSync('intermediate.out', mainFunction.cachedData);
      return;
    }
  }

  process.boxednode.hasCodeCache = codeCache.length > 0;
  // https://github.com/nodejs/node/pull/46320
  process.boxednode.rejectedCodeCache = mainFunction.cachedDataRejected;

  let jsTimingEntries = [];
  if (usesSnapshot) {
    v8.startupSnapshot.addDeserializeCallback(() => {
      jsTimingEntries = [];
    });
  }
  process.boxednode.markTime = (label) => {
    jsTimingEntries.push([label, process.hrtime.bigint()]);
  };
  process.boxednode.getTimingData = () => {
    if (isBuildingSnapshot()) {
      throw new Error('getTimingData() is not available during snapshot building');
    }
    const data = [
      ...jsTimingEntries,
      ...process._linkedBinding('boxednode_linked_bindings').getTimingData()
    ].sort((a, b) => Number(a[1] - b[1]));
    // Adjust times so that process initialization happens at time 0
    return data.map(([label, time]) => [label, Number(time - data[0][1])]);
  };

  mainFunction(__filename, __dirname, require, exports, module);
  return module.exports;
};
