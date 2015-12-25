'use strict';
var path = require('path');
var fs = require('fs');
var mkdirp = require('mkdirp');
var mqRemove = require('mq-remove');
require('ds-nrequire');
var glob = require('glob');
var assert = require('assert');
var config = require('config');
assert(config.dsAppRoot);
var _ = require('lodash');

// config
var APP_ROOT = config.dsAppRoot;
var DSC = config.dsComponentPrefix || 'dsc';
var DSCns = DSC.replace(/^\/+/, '').replace(/\/+$/, '');
DSC = DSCns + '/';

var css = require('css');
var list = glob.sync('.tmp/'+DSC+'*/css/**/*.css', {
    cwd: APP_ROOT,
});
var allParsed = {};
_.each(list, function (rpath) {
    var obj = allParsed[rpath.replace(/\.tmp\//, '/')] = {
        realPath: path.join(APP_ROOT, rpath),
    };
    obj.contents = fs.readFileSync(obj.realPath, 'utf8');
    obj.parsed = css.parse(obj.contents);
});
var replaced = _.transform(allParsed, function (r, obj, fpath) {
    var queue = [obj.parsed.stylesheet];
    process();
    function process() {
        var parsed;
        while ((parsed = queue.shift())) {
            replace(parsed);
        }
    }
    obj.contents = css.stringify(obj.parsed);
    r[fpath] = obj;
    function replace(parsed) {
        var replaced = {};
        if (!parsed.rules || !parsed.rules.length) {
            return parsed;
        }
        var i, rule;
        for (i = 0; i < parsed.rules.length; i++) {
            rule = parsed.rules[i];
            var dscReg = new RegExp('(?:url\\()?[\'"]?(\\\/'+DSCns+'\\\/[^\\\/]+\\\/css\\\/.+\\.css)[\'"]?\\)?');
            var match, ipath;
            if (rule.type !== 'import' || (!(match = rule.import.match(dscReg)))) {
                continue;
            }
            ipath = match[1];
            if (replaced[ipath]) {
                parsed.rules.splice(i, 1, {
                    "type": "comment",
                    "comment": ipath + ' already imported early',
                });
                continue;
            }
            replaced[ipath] = 1;
            Array.prototype.splice.apply(parsed.rules, [i, 1, {
                "type": "comment",
                "comment": " importing '" + ipath + "' from '" + require.resolve(ipath.substring(1)) + "' ",
            }].concat(allParsed[ipath].parsed.stylesheet.rules).concat([{
                "type": "comment",
                "comment": " imported '" + ipath + " '",
            }]));
        }
        queue = queue.concat(parsed.rules.filter(function (rule) {
            return (rule.rules && rule.rules.length);
        }));
    }
});
_.each(replaced, function (obj, fpath) {
    var wpath = path.join(APP_ROOT, '.tmp', fpath);
    mkdirp.sync(path.dirname(wpath));
    fs.writeFileSync(wpath, obj.contents, 'utf8');
    if (config.dsSupportIE8) {
        fs.writeFileSync(wpath.replace(/\.css$/, '.nmq.css'), mqRemove(obj.parsed, {
            width: '1200px'
        }), 'utf8');
    }
});
console.log('css @import replace done');
