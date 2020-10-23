'use strict';
const Module = require('module');
const vm = require('vm');
const path = require('path');
const src = require(REPLACE_WITH_SOURCE_PATH);
const requireMappings = REPLACE_WITH_REQUIRE_MAPPINGS;

module.exports = (() => {
  const __filename = process.execPath;
  const __dirname = path.dirname(process.execPath);
  const innerRequire = Module.createRequire(__filename);
  const exports = {};

  function require(module) {
    for (const [ re, linked ] of requireMappings) {
      try {
        if (re.test(module))
          return process._linkedBinding(linked);
      } catch {}
    }
    return innerRequire(module);
  }
  Object.defineProperties(require, Object.getOwnPropertyDescriptors(innerRequire));
  Object.setPrototypeOf(require, Object.getPrototypeOf(innerRequire));

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
