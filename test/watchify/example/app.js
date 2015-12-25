'use strict';
require('@ds/common');
GLOBAL.APP_ROOT = __dirname;
var fs = require('fs');
var path = require('path');
var express = require('express');

var app = express();
app.set('root', __dirname);
app.set('port', 7000);

require('../../').augmentApp(app);

app.get('/non-browserify', function (req, res, next) {
    console.log(3);
    res.type('html');
    res.send('<!doctype html><script src="/ccc/global.js" data-common></script>' +
        '<script src="/ccc/index/js/nb.js"></script>');
});

app.get('/*', function (req, res, next) {
    console.log(3);
    res.type('html');
    res.send('<!doctype html><script src="/ccc/global.js" data-common></script><script src="'+
        req.path + '.js"></script>');
});

app.listen(app.set('port'));
