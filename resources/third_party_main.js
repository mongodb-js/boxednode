'use strict'
const path = require('path')
// Since this behaves like a Node.js binary, it would not usually count itself
// as the script that is being run. Fix that by making process.argv[0] and
// process.argv[1] the same.
process.argv.unshift(__filename)
require(REPLACE_WITH_ENTRY_POINT)
