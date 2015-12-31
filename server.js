'use strict';
var assert = require('assert');
var config = require('config');
assert(config.dsAppRoot);

// config
var APP_ROOT = config.dsAppRoot;
var DSC = config.dsComponentPrefix || 'dsc';
var DSCns = DSC.replace(/^\/+/, '').replace(/\/+$/, '');
DSC = DSCns + '/';

var port = Number(process.env.PORT);
if (!port) {
    console.log('env variables PORT required.');
    process.exit(1);
}
require('./index')(port).catch(function (err) {
    console.error(err.stack);
});
