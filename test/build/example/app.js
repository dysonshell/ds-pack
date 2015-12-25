'use strict';
GLOBAL.APP_ROOT = __dirname;
var fs = require('fs');
var path = require('path');
var express = require('express');
var serveStatic = require('serve-static');
var rewriter = require('@ds/rewriter').bind(null, require('./dist/rev.json'));

var app = express();
app.set('root', __dirname);
app.set('port', 7000);

app.use('/ccc', serveStatic(path.join(APP_ROOT, 'dist', 'ccc')));

app.get('/non-browserify', function (req, res, next) {
    console.log(3);
    res.type('html');
    res.send(rewriter('<!doctype html><script src="/ccc/global.js" data-common></script>' +
        '<script src="/ccc/index/js/nb.js"></script>'));
});

app.get('/*', function (req, res, next) {
    var filePath = path.join(APP_ROOT, 'dist', req.path);
    console.log(3);
    res.type('html');
    res.send(rewriter('<!doctype html><script src="/ccc/global.js" data-common></script><script src="'+
        req.path + '.js"></script>'));
});

app.listen(app.set('port'));
