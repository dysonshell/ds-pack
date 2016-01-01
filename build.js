'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var config = require('config');
assert(config.dsAppRoot);
var Readable = require('stream').Readable;
var bpack = require('browser-pack');
var xtend = require('xtend');
var through = require('through2');
var es = require('event-stream');
var streamCombine = require('stream-combiner');
var dsRewriter = require('ds-rewriter');
var glob = require('glob');
var globby = require('globby');
var del = require('del');
var vinylPaths = require('vinyl-paths');
var exec = require('child_process').exec;
var mqRemove = require('mq-remove');
var browserify = require('browserify');
var partialify = require('partialify');
var coffeeify = require('coffeeify');
var babelify = require('babelify');
var es3ify = require('es3ify-safe');
var grtrequire = require('grtrequire');
var semver = require('semver');
var _ = require('lodash');
var VFile = require('vinyl');
var Promise = require('bluebird');
var dsWatchify = require('./watchify');
var respawn = require('respawn');
var mkdirp = require('mkdirp');

var unary = require('fn-unary');
var watch = require('gulp-watch');
var babel = require('gulp-babel');
var plumber = require('gulp-plumber');
var notify = require('gulp-notify');
var rimraf = require('rimraf');
var coffee = require('gulp-coffee');
var rev = require('gulp-rev');
var file = require('gulp-file');
var factorBundle = require('gulp-factor-bundle');
var uglify = require('gulp-uglify');
var nano = require('gulp-cssnano');
var revOutdated = require('gulp-rev-outdated');

var bufferFile = require('vinyl-fs/lib/src/getContents/bufferFile');

function ms(streams) {
    var outStream = through.obj();
    var len = streams.length;
    var fileLists = [];
    streams.forEach((stream, i) => {
        stream.pipe(through.obj(function (file, enc, cb) {
            var files = fileLists[i] || (fileLists[i] = []);
            files.push(file);
            cb();
        }, function () {
            --len || end();
            this.end();
        }));
        stream.on('error', outStream.emit.bind(outStream, 'error'));
    });
    function end() {
        es.readArray(_.flatten(fileLists)).pipe(outStream);
    }
    return outStream;
}

// config
var APP_ROOT = config.dsAppRoot;
var DSC = config.dsComponentPrefix || 'dsc';
var DSCns = DSC.replace(/^\/+/, '').replace(/\/+$/, '');
DSC = DSCns + '/';
var port = parseInt(process.env.PORT, 10) || config.port || 4000;
process.env.APP_ROOT = APP_ROOT;
process.env.PORT = ''+port;
var searchPrefix = (config.dsComponentFallbackPrefix || []).map(p => {
    if (typeof p !== 'string') return false;
    if (p.match(/[-\/]$/)) return p;
    return p.replace(/^\/+/, '') + '/';
}).filter(Boolean);

var dot = process.argv.indexOf('dev') > -1 ? 'dev' : 'tmp';

module.exports = function (gulp, opts) {

    var port = Number(process.env.PORT || opts.port);

    function rewrite(revMap) {
        return through.obj(function (obj, enc, cb) {
            obj.contents = new Buffer(dsRewriter(revMap, obj.contents.toString('utf-8')));
            this.push(obj);
            cb();
        });
    }

    function src(glob, opts) {
        opts = opts || {};
        var xopts = {
            cwd: APP_ROOT,
        };
        opts = xtend(xopts, opts);
        return gulp.src.call(gulp, glob, opts);
    }

    function dest() {
        var destPath = path.join.apply(path, [APP_ROOT].concat([].slice.call(
            arguments)));
        return gulp.dest(destPath);
    }

    function tBase(prefix) {
        return through.obj(function (obj, enc, cb) {
            obj.base = prefix ? path.join(APP_ROOT, prefix) : APP_ROOT;
            this.push(obj);
            cb();
        });
    }

    function tRev(prefix) {
        return streamCombine(
            tBase(prefix),
            rev()
        );
    }

    function tDest() {
        var fullRevPath = path.join(APP_ROOT, 'dist', 'rev.json');
        return streamCombine(
            dest('dist'), // write revisioned assets to /dist
            through.obj(function (obj, enc, cb) {
                console.log(obj.path);
                this.push(obj);
                cb();
            }),
            rev.manifest(fullRevPath, {
                path: fullRevPath,
                base: path.join(APP_ROOT, 'dist'),
                cwd: APP_ROOT,
                merge: true
            }), // generate a revision manifest file
            through.obj(function (obj, enc, cb) {
                console.log(obj.path);
                this.push(obj);
                cb();
            }),
            dest('dist') // write it to /dist/rev-manifest.json
        );
    }

    function tReplaceDsc() {
        return through.obj(function (file, enc, done) {
            file.base = file.base.replace('/node_modules/@'+DSC, '/'+DSC);
            file.path = file.path.replace('/node_modules/@'+DSC, '/'+DSC);
            this.push(file);
            done();
        });
    }

    function tReplaceTmp() {
        return through.obj(function (file, enc, done) {
            file.base = file.base.replace('/'+dot+'/'+DSC, '/'+DSC);
            file.path = file.path.replace('/'+dot+'/'+DSC, '/'+DSC);
            file.base = file.base.replace('/'+dot+'/', '/');
            file.path = file.path.replace('/'+dot+'/', '/');
            this.push(file);
            done();
        });
    }

    function errorAlert(error){
        notify.onError({
            title: "Gulp ERROR!",
            message: error.message || 'see terminal for details.',
            sound: "Sosumi",
        })(error); //Error Notification
        console.log(error.toString());//Prints Error to Console
        //this.emit("end"); //End function
    };

    gulp.task('rimraf', function (cb) {
        rimraf('./'+dot+'/', cb);
    });

    function tOrigPath() {
        return through.obj(function (file, enc, cb) {
            file.origPath = file.path;
            this.push(file);
            cb();
        });
    }

    var afiles = ['!' + DSC + dot+'/**/*']
        .concat([DSC].concat(searchPrefix).map(p => p + (p.match(/-$/) ? '*/**/*' : '**/*')))
        .reverse();

    var wafiles = [DSC + '**/*', '!' + DSC + dot+'/**/*'];

    gulp.task('nothing', ()=>{});
    gulp.task('prepare-assets', ['rimraf'], function () {
        return src(afiles)
            .pipe(tOrigPath())
            .pipe(dest(dot, DSC))
            .on('data', function (file) {
                console.log('- [', file.path, ']',
                '\n    copied from [', file.origPath, ']');
            })
    });

    var nfiles = filterJsFiles(globby.sync(_.flatten([
            [
                '!' + path.join(DSC, dot) + '/**/*.js',
                'config/**/*.js',
                'config/**/*.coffee',
            ],
            searchPrefix.map(p => (p.match(/-$/) ? [] : ['!' + p + 'preload.js']).concat([
                '!' + p + '*/js/**/*.js',
                '' + p + '**/*.js',
                '!' + p + '*/js/**/*.coffee',
                '' + p + '**/*.coffee',
            ]))], true).reverse(), {cwd: APP_ROOT}));

    var ncsfiles = nfiles.filter(p => p.match(/\.coffee$/));
    var njsfiles = nfiles.filter(p => p.match(/\.js$/));
    var wncsfiles = [
        'config/**/*.coffee',
        DSC + '**/*.coffee',
        '!' + DSC + '*/js/**/*.coffee',
        '!' + DSC + dot+'/**/*.coffee',
    ];
    var wnjsfiles = [
        'config/**/*.js',
        DSC + '**/*.js',
        '!' + DSC + '*/js/**/*.js',
        '!' + DSC + dot+'/**/*.js',
    ];

    function filterJsFiles(files) {
        var coffeeReg = /\.coffee$/i;
        return files.filter(function (item, i, all) {
            if (item.match(coffeeReg) &&
                    all.indexOf(item.replace(coffeeReg, '.js')) > -1) {
                return false;
            }
            return true;
        });
    }

    function tRmFallbackPath() {
        return through.obj(function (file, enc, cb) {
            var firstMatch = searchPrefix.filter(sp =>
                    file.path.indexOf(sp) > -1)[0];
            if (!firstMatch) {
                this.push(file);
                cb();
                return;
            }
            file.path = path.join(file.base, DSC, file.path.substring(file.path.indexOf(firstMatch) + firstMatch.length));
            this.push(file);
            cb();
        });
    }
    function tCoffee() {
        return streamCombine(
            tOrigPath(),
            coffee({bare: true}),
            tBase(),
            tRmFallbackPath()
        );
    }

    function tJS() {
        return streamCombine(
            tOrigPath(),
            babel({
                presets: [require('babel-preset-dysonshell/node-auto')],
            }),
            tBase(),
            tRmFallbackPath()
        );
    }


    gulp.task('prepare-njs', ['prepare-assets'], function () {
        return ms([
            gulp.src(ncsfiles, {cwd: APP_ROOT}).pipe(tCoffee()),
            gulp.src(njsfiles, {cwd: APP_ROOT}).pipe(tJS()),
            src(wncsfiles).pipe(tCoffee()).pipe(tBase()),
            src(wnjsfiles).pipe(tJS()).pipe(tBase())])
        .pipe(dest(dot))
        .on('data', function (file) {
            console.log('- [', file.path, ']\n    compiled from [', file.origPath, ']');
        })
    });

    gulp.task('prepare', ['prepare-njs', 'prepare-assets'], function () {
        return src(['ccc/**', '!ccc/**/*.js']).pipe(tBase())
            .pipe(src(dot+'/**').pipe(tBase(dot)))
            //.pipe(tReplaceTmp())
            .pipe(dest('dist'));
    })

    gulp.task('reset-rev-menifest', function () {
        var stream = file('rev.json', '{}');
        var d = stream.pipe(dest('dist'));
        stream.end();
        return d;
    });

    var globalLibsPath = path.join(APP_ROOT, dot, DSC, 'libs.json');
    var globalPreloadPath = path.join(APP_ROOT, dot, DSC, 'preload.js');
    var globalLibs, globalExternals;
    gulp.task('build-assets', ['reset-rev-menifest', 'prepare'], function () {

        if (!fs.existsSync(globalLibsPath)) {
            fs.writeFileSync(globalLibsPath, '[]', 'utf-8');
        }
        globalLibs = JSON.parse(fs.readFileSync(globalLibsPath, 'utf-8'));
        globalExternals = globalLibs.map(function (x) {
            return x[1] || x[0];
        }).filter(Boolean);

        if (!fs.existsSync(globalPreloadPath)) {
            fs.writeFileSync(globalPreloadPath, '', 'utf-8');
        }
        return src(dot+'/'+DSC+'*/img/**')
            .pipe(tReplaceTmp())
            .pipe(tRev())
            .pipe(tDest());
    });

    gulp.task('build-css', ['build-assets'], function () {
        require('./precss');
        return src(['./'+dot+'/'+DSC+'*/css/**/*.css'])
            .pipe(tReplaceTmp())
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json'), 'utf-8'))))
            .pipe(nano())
            .pipe(tRev())
            .pipe(tDest('css'));
    });

    function removeExternalDeps() {
        return through.obj(function (row, enc, done) {
            row.deps = _.transform(row.deps, function (result, dep, key) {
                if (dep) { // only add back if it's not false (which indicates the dep is external)
                    result[key] = dep;
                }
            });
            this.push(row);
            done();
        })
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
    function removePrefix(filepath) {
        if (filepath.indexOf(APP_ROOT) === 0) {
            filepath = filepath.substring(APP_ROOT.length);
        }
        if (filepath.indexOf('/'+dot+'/') === 0) {
            filepath = filepath.substring(4);
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

    var globalSrc;
    gulp.task('build-global-js', ['build-assets'], function () {
        return Promise.coroutine(function *() {
            globalSrc =
            (yield dsWatchify.bundle(globalPreloadPath, {
                watch: false,
                preludeSync: true,
            })).toString() + '\n;' +
            (yield dsWatchify.bundle(false, {
                global: true,
                watch: false,
                alterb: function (b) {
                    globalLibs.forEach(function (x) {
                        b.require(x[0], {expose: x[1] || x[0]});
                    });
                },
            })).toString();
        })();
    });
    gulp.task('build-js', ['build-global-js', 'build-css'], function () {
        var bcp = fs.readFileSync(require.resolve('browserify-common-prelude/dist/bcp.min.js'), 'utf-8');
        var files = glob.sync(DSC+'*/js/main/**/*.js', {
            cwd: path.join(APP_ROOT, dot),
        }).map(unary(path.join.bind(path, APP_ROOT, dot)));
        //var globalJsSrc = fs.readFileSync(require.resolve('@ds/common/dist/'+DSC+'global.js'), 'utf8');
        return es.merge(
            src(files)
                .pipe(through.obj(function (file, enc, done) {
                    console.log('trying to browserify js file: ' + file.path);
                    this.push(file);
                    done();
                }))
                .pipe(factorBundle({
                    b: (function() {
                        var b = new browserify({
                            extensions: ['.coffee'],
                            detectGlobals: true,
                            basedir: path.join(APP_ROOT, dot),
                            paths: ['.'],
                        });
                        b.external(globalExternals)
                        b.pipeline.get('deps').splice(1, 0, removeExternalDeps());
                        b.on('reset', function () {
                            this.external(globalExternals)
                            this.pipeline.get('deps').splice(1, 0, removeExternalDeps());
                            this.pipeline.get('dedupe').splice(0, 1);
                        });
                        return b;
                    }()),
                    alterPipeline: function alterPipeline(pipeline, b) {
                        if (!b.transformPatched) {
                            b
                                .transform(grtrequire, {global: true})
                                .transform(partialify, {global: true})
                                .transform(coffeeify, {bare: true})
                                .transform(babelify.configure({
                                    presets: [require('babel-preset-dysonshell')],
                                    only: new RegExp('\\\/'+DSCns+'\\\/'),
                                }))
                                .transform(es3ify, {global: true});
                            b.transformPatched = true;
                        }
                        pipeline.get('pack')
                            .splice(0, 1,
                            through.obj(function (row, enc, cb) {
                                row = removeRowPrefix(row);
                                this.push(row);
                                cb();
                            }),
                            bpack(xtend(b._options, {
                                raw: true,
                                hasExports: false,
                                prelude: bcp
                            })));
                    },
                    basedir: path.join(APP_ROOT, dot),
                    commonJsPath: DSC+'common.js' //"node_modules" will be removed
                }))
                //.pipe(tReplaceDsc())
                .pipe(through.obj(function (file, enc, done) {
                    if (file.path === path.join(APP_ROOT, dot+'/'+DSC+'common.js')) {
                        this.push(new VFile({
                            cwd: file.cwd,
                            base: file.base,
                            path: file.path.replace(/common\.js$/, 'global.js'),
                            contents: new Buffer(globalSrc, 'utf-8'),
                        }));
                        this.push(new VFile({
                            cwd: file.cwd,
                            base: file.base,
                            path: file.path.replace(/common\.js$/, 'global-common.js'),
                            contents: new Buffer(globalSrc.replace(/\[\]\)([\r\n\s]+\/\/#\s+sourceMapping)/, '[false])$1') + ';' + file.contents.toString(), 'utf-8'),
                        }));
                    }
                    this.push(file);
                    done();
                }))
                .pipe(tReplaceTmp())
                .pipe(through.obj(function (file, enc, done) {
                    console.log('trying to uglify js file: ' + file.path);
                    this.push(file);
                    done();
                }))
                .pipe(uglify({
                    compress: {
                        //drop_console: true
                    },
                    output: {
                        ascii_only: true,
                        quote_keys: true
                    }
                })),
            src([
                dot+'/'+DSC+'*/js/**/*.js',
                '!'+dot+'/**/js/dist/**',
                '!'+dot+'/**/js/main/**',
             ])
                .pipe(tJS())
                .pipe(tReplaceTmp())
                .pipe(through.obj(function (file, enc, done) {
                    console.log('trying to uglify js file: ' + file.path);
                    this.push(file);
                    done();
                }))
                .pipe(uglify({
                    compress: {
                        //drop_console: true
                    },
                    output: {
                        ascii_only: true,
                        quote_keys: true
                    }
                })),
            src([
                dot+'/'+DSC+'*/js/dist/**/*.js',
                '!'+dot+'/**/js/main/**',
            ])
                .pipe(tBase())
                .pipe(tRmFallbackPath())
                .pipe(tReplaceTmp())
        )
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json'), 'utf-8'))))
            .pipe(tRev())
            .pipe(tDest('js', 'node_modules'));
    });

    gulp.task('build-rev', ['build-js'], function () {
        var revMap = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json')));
        return src([dot+'/'+DSC+'*/partials/**/*.html', dot+'/'+DSC+'*/views/**/*.html'])
            .pipe(tBase(dot))
            .pipe(through.obj(function (file, enc, cb) {
                var contents = file.contents.toString();
                console.log('- revving template: ', file.path);
                if (config.dsSupportIE8) {
                    contents = contents.replace(/<link[^>]+rel=['"]?stylesheet['"]?[^>]+>/g, function (csslink) {
                        var nonie8 = dsRewriter(revMap, csslink);
                        if (nonie8 === csslink) {
                            return csslink;
                        }
                        var ie8 = dsRewriter(revMap, csslink, true);
                        return '<script>' +
                            'document.write((typeof window.matchMedia != "undefined" || typeof window.msMatchMedia != "undefined")?' +
                            '\''+nonie8.replace(/'/g, '"')+'\':'+
                            '\''+ie8.replace(/'/g, '"')+'\''+
                            ');</script>';
                    });
                }
                contents = dsRewriter(revMap, contents);
                file.contents = new Buffer(contents);
                // file.contents = new Buffer(dsRewriter(revMap, obj.contents.toString('utf-8')));
                this.push(file);
                cb();
            }))
            .pipe(dest('dist'));
    });

    gulp.task('build-and-clean', ['build-rev'], function () {
        return src('./dist/**/*')
            .pipe(revOutdated(5))
            .pipe(vinylPaths(del));
    });

    gulp.task('build', ['build-and-clean']);

    function exists(filePath) {
        return new Promise(function (resolve) {
            fs.exists(filePath, resolve);
        });
    }

    gulp.task('dev', ['prepare'], function () {
        var tmpAppRoot = path.join(APP_ROOT, dot);
        var m = respawn([process.execPath, path.join(tmpAppRoot, 'ccc', 'index.js')], {
            cwd: tmpAppRoot,
            env: {
                NODE_ENV: 'development',
                NODE_CONFIG: '{"dsAppRoot":"'+tmpAppRoot+'"}',
                NODE_CONFIG_DIR: path.join(tmpAppRoot, 'config'),
            },
            maxRestarts: 0,
            sleep: 0,
            stdio: 'inherit',
        });
        m.start();
        m.on('exit', function (code, signal) {
            if (!code) {
                return;
            }
            console.log('-------------------------------------------------------');
            console.log('app instance exited with code', code, 'and signal', signal);
            console.log('change and save server side script to restart');
            console.log('-------------------------------------------------------\n');
            errorAlert(new Error('app instance exited'));
        });

        function getAvailableFallbackFile(filePath) {
            var relativeFilePathWithoutExt = path.relative(path.join(APP_ROOT, DSCns), filePath.replace(/\..+?$/, ''));
            var paths = _([DSC].concat(searchPrefix))
                .map(function (dir) {
                    return [
                        path.join(APP_ROOT, dir, relativeFilePathWithoutExt + '.js'),
                        path.join(APP_ROOT, dir, relativeFilePathWithoutExt + '.coffee'),
                    ];
                })
                .flatten()
                .value();
            paths.push(
                path.join(APP_ROOT, DSC, 'index.js'),
                path.join(APP_ROOT, DSC, 'index.coffee')
            );
            return new Promise.coroutine(function* (resolve) {
                var p;
                while ( (p = paths.shift()) ) {
                    if (yield exists(p)) {
                        return p;
                    }
                }
                return false;
            })();
        }
        var nfiles = filterJsFiles(globby.sync(_.flatten([
                [
                    '!' + path.join(DSC, dot) + '/**/*.js',
                ],
                searchPrefix.map(p => (p.match(/-$/) ? [] : ['!' + p + 'preload.js']).concat([
                    '!' + p + '*/js/**/*.js',
                    '' + p + '**/*.js',
                    '!' + p + '*/js/**/*.coffee',
                    '' + p + '**/*.coffee',
                ]))], true).reverse(), {cwd: APP_ROOT}));
        function readFileThrough() {
            return through.obj(function (file, enc, cb) {
                if (!file.isNull()) {
                    this.push(file);
                    cb();
                    return;
                }
                fs.exists(file.path, exists => {
                    if (!exists) {
                        cb();
                        return;
                    }
                    bufferFile(file, (err, file) => {
                        if (err) {
                            this.emit('error', err);
                            cb();
                            return;
                        }
                        this.push(file);
                        cb();
                    });
                });
            });
        }
        var csupdate = through.obj();
        var csupdated = csupdate.pipe(through.obj(function (file, enc, cb) {
            Promise.coroutine(function *() {
                var jse = yield exists(file.path.replace(/\.coffee$/i, '.js'));
                if (jse) {
                    // do nothing
                    cb();
                    return;
                }
                var cse = yield exists(file.path);
                if (cse) {
                    csupdated.push(file);
                    cb();
                    return;
                } else {
                    fs.unlink(path.join(tmpAppRoot, path.relative(APP_ROOT, file.path.replace(/\.coffee$/i, '.js'))), (err) => {
                        console.error(err);
                        getAvailableFallbackFile(file.path).then(filePath => {
                            (filePath.match(/\.js$/) ? jsupdate : csupdate).push(new VFile({
                                cwd: file.cwd,
                                base: file.base,
                                path: filePath,
                            }));
                        });
                    });
                }
                cb();
            })();
        }));
        var aupdated = through.obj(function (file, enc, cb) {
            if (file.path.match(/\.js$/)) {
                if (path.relative(file.base, file.path).match(/\/js\//)) {
                    this.push(file);
                }
            } else {
                this.push(file);
            }
            cb();
        });
        var jsupdate = through.obj();
        var jsupdated = jsupdate.pipe(through.obj(function (file, enc, cb) {
            fs.exists(file.path, exists => {
                if (exists) {
                    this.push(file);
                } else {
                    fs.unlink(path.join(tmpAppRoot, path.relative(APP_ROOT, file.path)), (err) => {
                        console.error(err);
                        getAvailableFallbackFile(file.path).then(filePath => {
                            (filePath.match(/\.js$/) ? jsupdate : csupdate).push(new VFile({
                                cwd: file.cwd,
                                base: file.base,
                                path: filePath,
                            }));
                        });
                    });
                }
                cb();
            });
        }));
        watch(wncsfiles)
            .pipe(csupdated)
            .on('data', function (file) {
                console.log('- [', file.path, '] coffee updated');
            })
            .pipe(readFileThrough())
            .pipe(plumber({errorHandler: errorAlert}))
            .pipe(coffee({bare: true}))
            .pipe(tBase())
            .pipe(tRmFallbackPath())
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, '] coffee compiled');
                m.stop(function() {
                    m.start()
                })
            });

        watch(wnjsfiles)
            .pipe(jsupdated)
            .on('data', function (file) {
                console.log('- [', file.path, '] updated');
            })
            .pipe(readFileThrough())
            .pipe(plumber({errorHandler: errorAlert}))
            .pipe(babel({
                presets: [require('babel-preset-dysonshell/node-auto')],
            }))
            .pipe(tBase())
            .pipe(tRmFallbackPath())
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, '] babel compiled');
                m.stop(function() {
                    m.start()
                })
            });

        watch(wafiles)
            //.pipe(watch(wbjsfiles))
            .pipe(aupdated)
            .on('data', function (file) {
                console.log('- [', file.path, '] updated');
            })
            .pipe(tBase())
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, '] copied');
            });

        respawn([process.execPath, require.resolve('./server.js')], {
            env: {
                NODE_ENV: 'development',
                NODE_CONFIG: '{"dsAppRoot":"'+tmpAppRoot+'"}',
                NODE_CONFIG_DIR: path.join(tmpAppRoot, 'config'),
            },
            sleep: 0,
            stdio: 'inherit',
        }).start();
    });
};
