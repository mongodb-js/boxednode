'use strict';
const Module = require('module');
const vm = require('vm');
const path = require('path');
const src = require(REPLACE_WITH_SOURCE_PATH);

module.exports = (() => {
  const __filename = process.execPath;
  const __dirname = path.dirname(process.execPath);
  const require = Module.createRequire(__filename);
  const exports = {};
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
  ])(__filename, __dirname, require, exports, module);
  return module.exports;
})();
