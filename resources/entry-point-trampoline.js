'use strict';
const Module = require('module');
const vm = require('vm');
const path = require('path');
const {
  requireMappings,
  enableBindingsPatch
} = REPLACE_WITH_BOXEDNODE_CONFIG;
const hydatedRequireMappings =
  requireMappings.map(([re, reFlags, linked]) => [new RegExp(re, reFlags), linked]);

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

module.exports = (src) => {
  const __filename = process.execPath;
  const __dirname = path.dirname(process.execPath);
  const innerRequire = Module.createRequire(__filename);
  const exports = {};

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

  const module = {
    exports,
    children: [],
    filename: __filename,
    id: __filename,
    path: __dirname,
    require
  };
  vm.compileFunction(src, [
    '__filename', '__dirname', 'require', 'exports', 'module'
  ], {
    filename: __filename
  })(__filename, __dirname, require, exports, module);
  return module.exports;
};
