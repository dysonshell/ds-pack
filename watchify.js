'use strict';
//TODO: refactory, add test cases
var fs = require('fs');
var path = require('path');
var http = require('http');
var assert = require('assert');

var config = require('config');
assert(config.dsAppRoot);
require('ds-require');
var Promise = require('bluebird');
var _ = require('lodash');
var browserify = require('browserify');
var bpack = require('browser-pack');
var through = require('through2');
var glob = require('glob');
var isTcpOn = require('is-tcp-on');
var xtend = require('xtend');
var partialify = require('partialify');
var coffeeify = require('coffeeify');
var babelify = require('babelify');
var babelConnect = require('babel-connect');
var grtrequire = require('grtrequire/watch');
var es3ify = require('es3ify-safe');
var bcpPath = require.resolve('browserify-common-prelude/dist/bcp.js');
var bcp = fs.readFileSync(bcpPath, 'utf-8');

var httpProxy = require('http-proxy');
var express = require('express');
var DepGraph = require('dep-graph');
var mkdirp = require('mkdirp');
var crypto = require('crypto');
var sockjs = require('sockjs');
var chokidar = require('chokidar');
var anymatch = require('anymatch');
var EventEmitter = require('eventemitter3');
var tmplee = new EventEmitter;
var jsee = new EventEmitter;
function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

// config
var APP_ROOT = config.dsAppRoot;
var DSC = config.dsComponentPrefix || 'dsc';
var DSCns = DSC.replace(/^\/+/, '').replace(/\/+$/, '');
DSC = DSCns + '/';
var searchPrefix = (config.dsComponentFallbackPrefix || []).map(p => {
    if (typeof p !== 'string') return false;
    if (p.match(/[-\/]$/)) return p;
    return p.replace(/^\/+/, '') + '/';
}).filter(Boolean);

var globalLibsPath = path.join(APP_ROOT, DSC, 'libs.json');
if (!fs.existsSync(globalLibsPath)) {
    fs.writeFileSync(globalLibsPath, '[]', 'utf-8');
}
var globalLibs = JSON.parse(fs.readFileSync(globalLibsPath, 'utf-8'));
var globalExternals = globalLibs.map(function (x) {
    return x[1] || x[0];
}).filter(Boolean);

var globalPreloadPath = path.join(APP_ROOT, DSC, 'preload.js');
if (!fs.existsSync(globalPreloadPath)) {
    fs.writeFileSync(globalPreloadPath, '', 'utf-8');
}

var writeFile = Promise.promisify(fs.writeFile);

function exists(filePath) {
    return new Promise(function (resolve) {
        fs.exists(filePath, resolve);
    });
}
function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}
function alterPath(filePath) {
    return filePath
        .replace(/^([^\/])/, '/$1')
        .replace(/^\/.tmp\//, '/')
        ;
}

function getRelativePath(filePath) {
    return alterPath(
        path.relative(
            path.dirname(APP_ROOT, '.tmp'), // original APP_ROOT
            filePath));
}

function removeRowPrefix(row) {
    if (row.id) {
        row.id = removePrefix(row.id);
    }
    if (row.expose) {
        row.expose = removePrefix(row.expose);
    }
    if (row.dedupe) {
        row.dedupe = removePrefix(row.dedupe);
    }
    if (Object.keys(row.deps || {}).length > 0) {
        row.deps = _.mapValues(row.deps, removePrefix);
    }
    return row;
}
var rAppRoot = APP_ROOT.match(/\.tmp\/?$/) ?
        APP_ROOT.replace(/\/\.tmp\/?$/, '') :
        APP_ROOT;
function removePrefix(filepath) {
    if (filepath.indexOf(rAppRoot) === 0) {
        filepath = filepath.substring(rAppRoot.length);
    }
    if (filepath.indexOf('/.tmp/') === 0) {
        filepath = filepath.replace(/^\/+(\.tmp\/)?/, '');
    }
    filepath = filepath.replace(/^(\/)?\.\.\/node_modules\//, '$1node_modules/');
    filepath = rmFallbackPath(filepath);
    return filepath.replace(/^(?:\/+)?(.)/, '/$1');
}

function rmFallbackPath(filepath) {
    var firstMatch = searchPrefix.filter(sp =>
            filepath.indexOf(sp) === 0)[0];
    if (!firstMatch) {
        return filepath;
    }
    return filepath.replace(firstMatch, DSC);
}

var WATCHIFY_DELAY = 100;

// TODO: fork watchify to watchify-ee
var cache = this.cache = {};
var pkgcache = this.packageCache = {};
var changingDeps = {};
var pending = false;

var args = {
    extensions: ['.coffee'],
    basedir: APP_ROOT,
    paths: ['.'],
    cache: this.cache,
    packageCache: this.packageCache,
    fullPaths: true,
    // detectGlobals: false,
};
var chokidarWatched = {};

function chokidarWatch(file, opts) {
    if (chokidarWatched[file]) {
        return;
    }
    var w = chokidar.watch(file, opts);
    w.on('change', function () {
        invalidate(file);
    });
    chokidarWatched[file] = true;
}

function invalidate (id) {
    if (cache) delete cache[id];
    if (pkgcache) delete pkgcache[id];
    changingDeps[id] = true;

    // wait for the disk/editor to quiet down first:
    if (pending) clearTimeout(pending);
    pending = setTimeout(notify, WATCHIFY_DELAY);
}

function notify () {
    pending = false;
    jsee.emit('update', Object.keys(changingDeps));
    changingDeps = {};
}

function watchify(b, opts) {
    if (!opts) opts = {};

    var wopts = {persistent: true};
    if (opts.ignoreWatch) {
        var ignored = opts.ignoreWatch !== true
            ? opts.ignoreWatch
            : '**/node_modules/**';
    }
    if (opts.poll || typeof opts.poll === 'number') {
        wopts.usePolling = true;
        wopts.interval = opts.poll !== true
            ? opts.poll
            : undefined;
    }

    if (cache) {
        b.on('reset', collect);
        collect();
    }

    function collect () {
        b.pipeline.get('deps').push(through.obj(function(row, enc, next) {
            var file = row.expose ? b._expose[row.id] : row.file;
            cache[file] = {
                source: row.source,
                deps: xtend(row.deps)
            };
            this.push(row);
            next();
        }));
    }

    b.on('file', function (file) {
        watchFile(file);
    });

    b.on('package', function (pkg) {
        var file = path.join(pkg.__dirname, 'package.json');
        watchFile(file);
        if (pkgcache) pkgcache[file] = pkg;
    });

    var ignoredFiles = {};

    b.on('transform', function (tr, mfile) {
        tr.on('file', function (dep) {
            watchFile(mfile, dep);
        });
    });

    function watchFile (file, dep) {
        dep = dep || file;
        if (ignored) {
            if (!ignoredFiles.hasOwnProperty(file)) {
                ignoredFiles[file] = anymatch(ignored, file);
            }
            if (ignoredFiles[file]) return;
        }
        chokidarWatch(dep, wopts);
    }

    return b;
};

function alterPipeline(b, opts) {
    opts = opts || {};
    b
        .transform(grtrequire)
        .transform(partialify)
        .transform(coffeeify, {bare: true})
        .transform(babelify, {
            presets: [require('babel-preset-dysonshell')],
            only: new RegExp('\\\/' + DSCns + '\\\/'),
        })
    if (config.dsSupportIE8) {
        b.transform(es3ify, {global: true});
    }
    b.pipeline.get('dedupe').splice(0, 1); // arguments[4] bug
    b.pipeline.get('pack')
        .splice(0, 1, through.obj(function (row, enc, next) {
            row = removeRowPrefix(row);
            row.sourceFile = path.join('/-', row.id);
            this.push(row);
            next();
        }), bpack(xtend(args, {
            raw: true,
            hasExports: false,
            prelude: bcp + (!opts.preludeSync ? '' : ';BCP.preludeSync'),
            preludePath: bcpPath,
        })));
    if (!opts.global) {
        b.external(globalExternals);
    }
    return b;
}

var bundle = Promise.coroutine(function* (fullPath, opts) {
    opts = opts || {};
    var b = browserify(args);
    if (opts.watch !== false) {
        watchify(b, {poll: require('os').type() === 'Darwin' ? false : 500});
    }
    alterPipeline(b, opts);
    if (typeof opts.alterb === 'function') {
        opts.alterb(b);
    }
    if (fullPath) {
        b.add(fullPath);
    }
    var src = yield bundlePromise(b);
    if (!fullPath) {
        return src;
    }
    var tmpSavePath = getTmpSavePath(fullPath);
    if (tmpSavePath) {
        yield Promise.promisify(mkdirp)(path.dirname(tmpSavePath));
        console.log('write template file:', tmpSavePath);
        yield writeFile(tmpSavePath, src);
    }
    return src;
});

function bundlePromise(b) { // because b.bundle checks arity :(
    return new Promise(function (resolve, reject) {
        b.bundle(function (err, src) {
            if (err) {
                return reject(err);
            }
            resolve(src);
        });
    });
}


jsee.on('update', console.log.bind(console, 'updated:'));
jsee.on('update', onUpdate);
function onUpdate(updatedFiles) {
    var dg = new DepGraph();
    _.each(args.cache, function (row, id) {
        _.each(row.deps, function (dep) {
            dg.add(dep, id); // dep will affect id
        });
    });
    var affectedFiles = _.union(
        updatedFiles,
        updatedFiles.reduce(function (result, updatedFile) {
            return _.union(result, dg.getChain(updatedFile));
        }, [])
    );
    console.log('affected:', affectedFiles);

    updatedFiles.forEach(function (filePath) {
        if (filePath.match(/\.html$/)) {
            fs.readFile(filePath, 'utf-8', function (err, contents) {
                var rPath = path.relative(APP_ROOT, filePath);
                tmplee.emit(rPath, contents);
            });
        }
    })

    affectedFiles
    .filter(function (filePath) {
        return filePath.match(/\.(html|js)$/i);
    })
    .forEach(function (filePath) {
        bundle(filePath)
        .catch(bundleErrStr);
    })
}
function bundleErrStr(err) {
    var errPrint = [];
    errPrint.push('------------------------------------------------------------');
    if (err.filename) {
        errPrint.push('error on file ' + err.filename);
    }
    if (err.description) {
        errPrint.push(err.description);
    }
    if (err.filename && err.lineNumber && err.column) {
        errPrint.push(err.filename +':'+ err.lineNumber +':'+ err.column);
    }
    errPrint.push('------------------------------------------------------------');
    errPrint.push(err.stack || err.toString());
    var errStr = errPrint.join('\n');
    console.log(errStr);
    return errStr;
}
function getTmpSavePath(filePath) {
    var reqId = path.relative(APP_ROOT, filePath);
    if (reqId.indexOf(DSC) !== 0) {
        return false;
    }
    var tmpSaveFile = reqId.replace(DSC, DSC + '.tmp/');
    var tmpSavePath = path.join(APP_ROOT, tmpSaveFile);
    return tmpSavePath;
}

var initRouter = function () {
    var router = express.Router();
    var globalSrcPromise = bundle(false, {
        global: true,
        watch: false,
        alterb: function (b) {
            globalLibs.forEach(function (x) {
                b.require(x[0], {expose: x[1] || x[0]});
            });
        },
    });
    var preloadSrcPromise = bundle(globalPreloadPath, {
        watch: false,
        preludeSync: true,
    });
    var commonSrc = '\n;' + bcp + '({});';
    var watchAllPartials = bundle(false, {
        watch: true,
        alterb: function (b) {
            glob.sync(DSC + '*/partials/**/*.html', {cwd: APP_ROOT}).forEach(function (partial) {
                b.add(partial);
            });
        },
    });
    var src;
    var allPromise = Promise.all([globalSrcPromise, preloadSrcPromise, watchAllPartials]);
    allPromise.then(function (results) {
        var globalSrc = results[0].toString();
        var preloadSrc = results[1].toString();
        src = {
            global: (preloadSrc + ';' + globalSrc).replace(/[\r\n]\/\/#\s+sourceMapping[^\r\n]*/g, ''),
            'global-common': (preloadSrc + ';' + globalSrc.replace(/\[\]\)([\r\n\s]+\/\/#\s+sourceMapping)/, '[false])$1') + ';' + commonSrc).replace(/[\r\n]\/\/#\s+sourceMapping[^\r\n]*/g, ''),
            common: commonSrc,
        };
    });
    router.use(function (req, res, next) {
        allPromise.then(function () {
            next();
        });
    });
    var globalJsEtag = JSON.stringify(Date.now());
    router.get(new RegExp('^\\\/'+DSCns+'\\\/(global|global-common|common)\\.js'), function (req, res) {
        res.type('js');
        res.set('cache-control', 'public,max-age=' + (60 * 60 * 24));
        res.set('etag', globalJsEtag);
        if (req.header('if-none-match') === globalJsEtag) {
            res.statusCode = 304;
            res.end();
            return;
        }
        res.send(src[req.params[0]]);
    });
    router.get(new RegExp('^\\\/'+DSCns+'\\\/[^\\\/]+\\\/js\\\/.*\\.js$'), function (req, res, next) {
        var filePath;
        try {
            filePath = require.resolve(req.path.replace(/^\/+/, ''));
        } catch (e) {}
        if (!filePath || req.path.indexOf('/js/main/') === -1) {
            return next();
        }
        res.type('js');
        bundle(filePath)
        .then(function (src) {
            res.set('etag', md5(src));
            res.send(src);
        })
        .catch(function (err) {
            var errStr = bundleErrStr(err);
            res.statusCode = 500;
            return res.send('/*\n' + errStr + '\n */\n');
        });
    });
    // router.use(express.static(path.join(APP_ROOT, 'node_modules')));
    router.use('/-', express.static(APP_ROOT));
    // watch all templates

    console.log('watchify router inited');
    return router;
};

var watchifyServer = Promise.coroutine(function *(port) {
    var watchifyApp = require('express')();
    var server = http.createServer(watchifyApp);
    (function(sock) {
        sock.installHandlers(server, {prefix: '/_sockjs'});
        sock.on('connection', function (conn) {
            var unsubs = [];
            function write(filePath, template) {
                conn.write(JSON.stringify({
                    'filePath': filePath,
                    'template': template,
                }));
            }
            function subscribe(filePath) {
                var fullPath = path.join(APP_ROOT, filePath);
                // tmplee.emit(filePath, '<p>hello</p>');
                fs.readFile(fullPath, 'utf-8', function (err, template) {
                    if (!err) {
                        bundle(filePath);
                        write(filePath, template);
                        var notify = write.bind(null, filePath);
                        tmplee.addListener(filePath, notify);
                        unsubs.push(function () {
                            tmplee.removeListener(filePath, notify);
                        });
                    }
                });
            }
            conn.on('data', function (message) {
                var payload;
                try {
                    payload = JSON.parse(message);
                } catch (e) {}
                if (Array.isArray(payload.filePaths)) {
                    payload.filePaths.forEach(subscribe);
                }
            });
            conn.on('close', function () {
                unsubs.forEach(function (unsub) {
                    unsub();
                });
            })
        });
    }(sockjs.createServer({
    })))
    watchifyApp.set('etag', false);
    watchifyApp.use(require('morgan')());
    watchifyApp.use('/node_modules', initRouter());
    yield Promise.promisify(server.listen, {context: server})(port + 500);
    var address = server.address();
    console.log("watchify listening at http://127.0.0.1:%d", address.port);
    var errCounter = 0;
    function checkApp() {
        return isTcpOn({host: '127.0.0.1', port: port}).catch(function () {
            return false;
        });
    }
    Promise.coroutine(function *() {
        // 遇到过主进程没有了而 watchify 的进程还在的情况，所以在这里设置一个心跳检查
        yield sleep(4000);
        while (true) {
            yield sleep(1000);
            var checkResult = yield checkApp();
            if (!checkResult && ++errCounter > 4) {
                // 连续 5 秒的检测都失败才退出，因为可能是正好在重启
                throw new Error('app server down');
            } else {
                errCounter = 0;
            }
        }
    })().catch(function (e) {
        process.nextTick(function () {
            process.kill(process.pid, 'SIGTERM'); // 如果主网站不行了，给自己发 kill 信号
        });
    });
})

exports = module.exports = watchifyServer;
exports.augmentApp = require('./augment-app');
exports.bundle = bundle;
