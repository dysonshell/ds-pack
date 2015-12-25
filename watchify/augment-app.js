'use strict';

var assert = require('assert');
var config = require('config');
assert(config.dsAppRoot);
var httpProxy = require('http-proxy');

// config
var APP_ROOT = config.dsAppRoot;
var DSC = config.dsComponentPrefix || 'dsc';
var DSCns = DSC.replace(/^\/+/, '').replace(/\/+$/, '');
DSC = DSCns + '/';

module.exports = function (app, appPort) {
    if (app.get('env') !== 'development') {
        return;
    }
    var target = 'http://127.0.0.1:' + (appPort + 500) + '/node_modules';
    console.log('js entry files proxy target: ', target);
    var proxy = httpProxy.createProxyServer({
        target: target,
    });
    app.get(new RegExp('^(\\\/-)?\\\/(node_modules|'+DSCns+')\\\/.+\\.js$'), function (req, res, next) {
        return proxy.web(req, res, null, next);
    });
    var proxySockjs = httpProxy.createProxyServer({
        target: 'http://127.0.0.1:' + (appPort + 500),
    });
    var proxyWS = httpProxy.createProxyServer({
        target: 'ws://127.0.0.1:' + (appPort + 500),
        ws: true,
    });
    app.use(function (req, res, next) {
        if (!req.url.match(/^\/_sockjs/)) {
            return next();
        }
        return proxySockjs.web(req, res, null, function (err, req, res) {
            res.statusCode = 500;
            res.end();
        });
    });
    if (app.httpServer) {
        app.httpServer.on('upgrade', function (req, socket, head) {
            console.log('upgrade', req.url);
            return proxyWS.ws(req, socket, head);
        });
    }
};
