'use strict';
const Module = require('module');
const vm = require('vm');
const path = require('path');
const {
  srcMod,
  requireMappings,
  enableBindingsPatch
} = REPLACE_WITH_BOXEDNODE_CONFIG;
const src = require(srcMod);
const hydatedRequireMappings =
  requireMappings.map(([re, reFlags, linked]) => [new RegExp(re, reFlags), linked]);

if (enableBindingsPatch) {
  const fs = require('fs');
  const origFsAccessSync = fs.accessSync;
  fs.accessSync = (filename, ...args) => {
    if (path.basename(filename) === 'node_modules' &&
        path.join(path.dirname(filename), '..') === path.dirname(filename)) {
      return;
    }
    return origFsAccessSync.call(fs, filename, ...args);
  };
}

module.exports = (() => {
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

  process.argv[1] = __filename;

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
})();
