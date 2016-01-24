'use strict';
var fs = require('fs');
var path = require('path');
var Readable = require('stream').Readable;
var bpack = require('browser-pack');
var xtend = require('xtend');
var through = require('through2');
var es = require('event-stream');
var streamCombine = require('stream-combiner');
var glob = require('glob');
var globby = require('globby');
var del = require('del');
var vinylPaths = require('vinyl-paths');
var exec = require('child_process').exec;
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
var sourcemaps = require('gulp-sourcemaps');

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


module.exports = function (gulp, opts) {

    // config
    var APP_ROOT = path.resolve(__dirname, '..', '..').replace(/node_modules[\\\/]dysonshell$/, '');
    var dot = process.argv.indexOf('dev') > -1 ? 'dev' : 'tmp';
    var SRC_ROOT = path.join(APP_ROOT, 'src');
    var DOT_ROOT = path.join(APP_ROOT, dot);
    var config, port, dsRewriter, searchPrefix, DSC, DSCns;

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
            cwd: DOT_ROOT,
        };
        opts = xtend(xopts, opts);
        return gulp.src.call(gulp, glob, opts);
    }

    function dest() {
        var destPath = path.join.apply(path, [APP_ROOT].concat([].slice.call(arguments)));
        return gulp.dest(destPath);
    }

    function tBase(prefix) {
        var args = [].slice.call(arguments).filter(Boolean);
        return through.obj(function (file, enc, cb) {
            file.base = path.join.apply(path, [APP_ROOT].concat(args));
            this.push(file);
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
            rev.manifest(fullRevPath, {
                path: fullRevPath,
                base: path.join(APP_ROOT, 'dist'),
                cwd: DOT_ROOT,
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
            file.base = file.base.replace('/'+dot, '/');
            file.path = file.path.replace('/'+dot, '/');
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

        // extract babel compile error hint
        var stacks = (error.stack || '').split(/\n/g).slice(1);
        var regexBabelHintWithLineNumber = /^[^\|]*\s+(\d+)?\s+\|/;
        if (!(stacks[0]||'').match(regexBabelHintWithLineNumber)) {
            return;
        }
        var r = [];
        var line;
        while ( ((line = stacks.shift()) || '').match(regexBabelHintWithLineNumber) ) {
            r.push(line);
        }
        console.log(r.join('\n'));//Prints Error to Console
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

    gulp.task('prepare-config', ['rimraf'], function () {
        return ms([
            gulp.src('config/**/*.coffee', {cwd: SRC_ROOT}).pipe(tCoffee()),
            gulp.src('config/**/*.js', {cwd: SRC_ROOT}).pipe(tJS())
        ])
            .pipe(tBase('src'))
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, ']\n    compiled from [', file.origPath, ']');
            })
    });

    var files = {};
    var wafiles = ['src/**/*', '!**/*~'];
    var wnjsfiles = ['src/**/*.js', '!**/*~'];
    var wncsfiles = ['src/**/*.coffee', '!**/*~'];

    gulp.task('load-config', ['prepare-config'], function () {
        process.env.NODE_CONFIG_DIR = path.join(DOT_ROOT, 'config');
        config = require('config');
        config.dsAppRoot = DOT_ROOT;
        //console.log(JSON.stringify(_.pick(config, Object.keys(config).filter(k => k.match(/^ds/))), null, '    '));
        DSCns = (config.dsComponentPrefix || 'dsc').replace(/^\/+/, '').replace(/\/+$/, '');
        DSC = DSCns + '/';
        port = parseInt(process.env.PORT, 10) || config.port || 4000;
        process.env.PORT = ''+port;
        dsRewriter = require('ds-rewriter');
        searchPrefix = ['src/'+DSC].concat((config.dsComponentFallbackPrefix || []).map(p => {
            if (typeof p !== 'string') return false;
            if (p.match(/[-\/]$/)) return p;
            return p.replace(/^\/+/, '') + '/';
        })).filter(Boolean);
        //console.log(searchPrefix);

        files.a = _.flatten([
            searchPrefix.map(p => (p.match(/-$/) || p === 'src/'+DSC ? [] : ['!' + p + 'preload.js']).concat([
                '' + p + '*/js/dist/**/*.js',
                '!' + p + '*/js/**/*.js',
                '' + p + '*/**/*',
            ])),
            'src/**/*',
            '!src/config/**/*',
        ], true).reverse()

        files.njs = _.flatten([
            searchPrefix.map(p => (p.match(/-$/) ? [] : ['!' + p + 'preload.js']).concat([
                '!' + p + '*/node_modules/**/*.js',
                '!' + p + '*/js/**/*.js',
                '' + p + '**/*.js',
            ])),
            '!src/*/js/dist/**/*.js',
            'src/**/*.js',
            '!src/config/**/*',
        ], true).reverse()

        files.bjs = _.flatten([
            'src/'+DSC+'preload.js',
            searchPrefix.map(p => [
                '!' + p + '*/js/dist/**/*.js',
                '' + p + '*/js/**/*.js',
            ])
        ], true).reverse()

        files.cs = _.flatten([
            searchPrefix.map(p => [
                '!' + p + '*/node_modules/**/*.coffee',
                '' + p + '*/**/*.coffee',
            ])
        ], true).reverse()

        //console.log(files);

        files = _.mapValues(files, function (v) {
            return globby.sync(v, {cwd: APP_ROOT});
        });

        //console.log(files);

        /*
        console.log(afiles, njsfiles, bjsfiles, csfiles);
        console.log([afiles, njsfiles, bjsfiles, csfiles].map(d => globby.sync(d, {cwd: APP_ROOT})));
        */
    });

    gulp.task('prepare-assets', ['load-config'], function () {
        return gulp.src(files.a)
            .pipe(tOrigPath())
            .pipe(tBase('src'))
            .pipe(tRmFallbackPath())
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, ']',
                '\n    copied from [', file.origPath, '] base', file.base);
            })
    });

    function tRmFallbackPath() {
        return through.obj(function (file, enc, cb) {
            var firstMatch;
            //console.log(11, file.path);
            if (!searchPrefix || !searchPrefix.length ||
                    !(firstMatch = searchPrefix.filter(sp => file.path.indexOf(sp) > -1)[0])) {
                this.push(file);
                cb();
                return;
            }
            //console.log(11, firstMatch);
            file.path = path.join(SRC_ROOT, DSC, file.path.substring(file.path.indexOf(firstMatch) + firstMatch.length));
            //console.log(11, file.path);
            this.push(file);
            cb();
        });
    }
    function tCoffee() {
        return streamCombine(
            tOrigPath(),
            tBase('src'),
            sourcemaps.init(),
            coffee({bare: true}),
            sourcemaps.write(),
            tRmFallbackPath()
        );
    }

    function tJS(browser) {
        return streamCombine(
            tOrigPath(),
            tBase('src'),
            sourcemaps.init(),
            tBabel(),
            sourcemaps.write(),
            plumber.stop(),
            tRmFallbackPath()
        );
    }

    function tBabel() {
        var t = through.obj(function (file, enc, cb) {
            if (path.relative(file.base, file.path).match(/\/js\//)) {
                b.push(file);
            } else {
                n.push(file);
            }
            cb();
        });
        t.on('end', t.push.bind(t, null));
        var out = through.obj(function (file, enc, cb) {
            t.push(file);
            cb();
        });
        var b = through.obj();
        var n = through.obj();
        t.on('end', b.push.bind(b, null));
        t.on('end', n.push.bind(n, null));
        var nbabel = n
            .pipe(plumber({errorHandler: errorAlert}))
            .pipe(babel({
                presets: [require('babel-preset-dysonshell/node-auto')],
            })).pipe(out);
        var bbabel = b
            .pipe(plumber({errorHandler: errorAlert}))
            .pipe(babel({
                presets: [require('babel-preset-dysonshell')],
            })).pipe(out);
        return t;
    }

    gulp.task('prepare-js', ['prepare-assets'], function () {
        return ms([
            gulp.src(files.cs).pipe(tCoffee()),
            gulp.src(files.njs).pipe(tJS()),
            gulp.src(files.bjs).pipe(tJS()),
            gulp.src(wncsfiles).pipe(tCoffee()),
            gulp.src(wnjsfiles).pipe(tJS()),
        ])
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, ']\n    compiled from [', file.origPath, ']');
            })
    });

    gulp.task('prepare', ['prepare-js', 'prepare-assets'], function () {
        return gulp.src(['src/'+DSC+'**', '!**/*.js'], {cwd: APP_ROOT}).pipe(tBase('src'))
            .pipe(dest(dot));
    });

    gulp.task('build-config', ['prepare-config'], function () {
        return gulp.src('config/**/*', {cwd: DOT_ROOT})
            //.pipe(tReplaceTmp())
            .pipe(tBase('tmp'))
            .pipe(dest('dist'));
    });

    gulp.task('prepare-build', ['prepare'], function () {
        return gulp.src('**/*', {cwd: DOT_ROOT})
            //.pipe(tReplaceTmp())
            .pipe(tBase('tmp'))
            .pipe(dest('dist'));
    });

    gulp.task('reset-rev-menifest', function () {
        var stream = file('rev.json', '{}');
        var d = stream.pipe(dest('dist'));
        stream.end();
        return d;
    });

    var globalLibs, globalExternals, globalLibsPath, globalPreloadPath;

    gulp.task('build-assets', ['reset-rev-menifest', 'prepare-build'], function () {

        globalLibsPath = path.join(DOT_ROOT, DSC, 'libs.json');
        globalPreloadPath = path.join(DOT_ROOT, DSC, 'preload.js');

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

        return src([DSC+'*/img/**', DSC+'*/js/dist/**/*.js'])
            //.pipe(tReplaceTmp())
            .pipe(tRev('tmp'))
            .pipe(tDest());

    });

    gulp.task('build-css', ['build-assets'], function () {
        require('./precss');
        return src([DSC+'*/css/**/*.css'])
            //.pipe(tReplaceTmp())
            .pipe(tBase('tmp'))
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json'), 'utf-8'))))
            .pipe(nano())
            .pipe(tRev('tmp'))
            .pipe(tDest());
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
        if (filepath.indexOf('/src/') === 0 ||
            filepath.indexOf('/dev/') === 0 ||
            filepath.indexOf('/tmp/') === 0
        ) {
            filepath = filepath.substring(4);
        }
        filepath = filepath.replace(/^(\/)?\.\.\/node_modules\//, '$1node_modules/');
        filepath = rmFallbackPath(filepath);
        return filepath.replace(/^(?:\/+)?(.)/, '/$1');
    }

    function rmFallbackPath(filepath) {
        var firstMatch = ['src/'+DSC].concat(searchPrefix).filter(sp =>
                filepath.indexOf(sp) === 0)[0];
        if (!firstMatch) {
            return filepath;
        }
        return filepath.replace(firstMatch, DSC);
    }

    var globalSrc;
    gulp.task('build-global-js', ['build-assets'], function () {
        var dsWatchify = require('./watchify');
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
    gulp.task('build-nonmain-js', ['build-global-js', 'build-css'], function () {
        var bcp = fs.readFileSync(require.resolve('browserify-common-prelude/dist/bcp.min.js'), 'utf-8');
        var files = glob.sync(DSC+'*/js/main/**/*.js', {
            cwd: DOT_ROOT,
        }).map(unary(path.join.bind(path, DOT_ROOT)));
        //var globalJsSrc = fs.readFileSync(require.resolve('@ds/common/dist/'+DSC+'global.js'), 'utf8');
        return src([
            DSC+'*/js/**/*.js',
            '!'+'/**/js/dist/**',
            '!'+'/**/js/main/**',
        ])
            .pipe(through.obj(function (file, enc, done) {
                console.log('trying to uglify js file: ' + file.path, 'base:', file.base);
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
            }))
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json'), 'utf-8'))))
            .pipe(tRev(dot))
            .pipe(tDest());
    });
    gulp.task('build-main-js', ['build-nonmain-js'], function () {
        var bcp = fs.readFileSync(require.resolve('browserify-common-prelude/dist/bcp.min.js'), 'utf-8');
        var files = glob.sync(DSC+'*/js/main/**/*.js', {
            cwd: DOT_ROOT,
        }).map(unary(path.join.bind(path, DOT_ROOT)));
        //var globalJsSrc = fs.readFileSync(require.resolve('@ds/common/dist/'+DSC+'global.js'), 'utf8');
        return src(files)
            .pipe(through.obj(function (file, enc, done) {
                console.log('trying to browserify js file: ' + file.path);
                this.push(file);
                done();
            }))
            .pipe(factorBundle({
                b: (function() {
                    var b = new browserify({
                        detectGlobals: true,
                        basedir: DOT_ROOT,
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
                            //.transform(coffeeify, {bare: true})
                            //.transform(babelify.configure({
                                //presets: [require('babel-preset-dysonshell')],
                                //only: new RegExp('\\\/'+DSCns+'\\\/'),
                            //}))
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
                basedir: DOT_ROOT,
                commonJsPath: DSC+'common.js' //"node_modules" will be removed
            }))
            //.pipe(tReplaceDsc())
            .pipe(through.obj(function (file, enc, done) {
                //console.log(file.path);
                if (file.path === path.join(DOT_ROOT, DSC, 'common.js')) {
                    //console.log(1);
                    this.push(new VFile({
                        cwd: file.cwd,
                        base: file.base,
                        path: file.path.replace(/common\.js$/, 'global.js'),
                        contents: new Buffer(globalSrc, 'utf-8'),
                    }));
                    //console.log(2);
                    this.push(new VFile({
                        cwd: file.cwd,
                        base: file.base,
                        path: file.path.replace(/common\.js$/, 'global-common.js'),
                        contents: new Buffer(globalSrc.replace(/\[\]\)([\r\n\s]+\/\/#\s+sourceMapping)/, '[false])$1') + ';' + file.contents.toString(), 'utf-8'),
                    }));
                }
                    //console.log(3);
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
            }))
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json'), 'utf-8'))))
            .pipe(tRev())
            .pipe(tDest());
    });

    gulp.task('build-js', ['build-main-js']);

    gulp.task('build-rev', ['build-js'], function () {
        var revMap = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json')));
        return src([DSC+'*/partials/**/*.html', DSC+'*/views/**/*.html'])
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
        return src('dist/**/*')
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
        var m = respawn([process.execPath, path.join(DOT_ROOT, 'index.js')], {
            cwd: DOT_ROOT,
            env: {
                NODE_ENV: 'development',
                NODE_CONFIG: '{"dsAppRoot":"'+DOT_ROOT+'"}',
                NODE_CONFIG_DIR: path.join(DOT_ROOT, 'config'),
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
            var relativeFilePathWithoutExt = path.relative(path.join(SRC_ROOT, DSCns), filePath.replace(/\..+?$/, ''));
            var paths = _([DSC].concat(searchPrefix))
                .map(function (dir) {
                    return [
                        path.join(SRC_ROOT, dir, relativeFilePathWithoutExt + '.js'),
                        path.join(SRC_ROOT, dir, relativeFilePathWithoutExt + '.coffee'),
                    ];
                })
                .flatten()
                .value();
            paths.push(
                path.join(SRC_ROOT, DSC, 'index.js'),
                path.join(SRC_ROOT, DSC, 'index.coffee'),
                path.join(SRC_ROOT, 'index.js'),
                path.join(SRC_ROOT, 'index.coffee')
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
                    fs.unlink(path.join(DOT_ROOT, path.relative(SRC_ROOT, file.path.replace(/\.coffee$/i, '.js'))), (err) => {
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
            if (!file.path.match(/\.(js|coffee)$/)) {
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
                    fs.unlink(path.join(DOT_ROOT, path.relative(SRC_ROOT, file.path)), (err) => {
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
        watch(wncsfiles, {cwd: APP_ROOT})
            .pipe(csupdated)
            .on('data', function (file) {
                console.log('- [', file.path, '] coffee updated');
            })
            .pipe(readFileThrough())
            .pipe(plumber({errorHandler: errorAlert}))
            .pipe(sourcemaps.init())
            .pipe(coffee({bare: true}))
            .pipe(sourcemaps.write())
            .pipe(tBase('src'))
            .pipe(tRmFallbackPath())
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, '] coffee compiled');
                if (path.relative(file.base, file.path).indexOf('/js/') === -1) {
                    m.stop(function() {
                        m.start()
                    })
                }
            });


        watch(wnjsfiles, {cwd: APP_ROOT})
            .pipe(jsupdated)
            .on('data', function (file) {
                console.log('- [', file.path, '] updated');
            })
            .pipe(readFileThrough())
            .pipe(sourcemaps.init())
            .pipe(tBabel())
            .pipe(sourcemaps.init())
            .pipe(tBase('src'))
            .pipe(tRmFallbackPath())
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, '] babel compiled');
                if (path.relative(file.base, file.path).indexOf('/js/') === -1) {
                    m.stop(function() {
                        m.start()
                    })
                }
            });

        watch(wafiles, {cwd: APP_ROOT})
            //.pipe(watch(wbjsfiles))
            .pipe(aupdated)
            .on('data', function (file) {
                console.log('- [', file.path, '] updated');
            })
            .pipe(tBase('src'))
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, '] copied');
            });

        var fork = require('child_process').fork;

        var w = fork(path.resolve(__dirname, './server.js'), {
            env: xtend(process.env, {
                NODE_ENV: 'development',
                NODE_CONFIG: '{"dsAppRoot":"'+DOT_ROOT+'"}',
                NODE_CONFIG_DIR: path.join(DOT_ROOT, 'config'),
            }),
        });
        w.on('error', errorAlert);
        w.on('error', console.error.bind(console, 'watchify process error'))
        w.on('close', console.error.bind(console, 'watchify process closed'))
        w.on('disconnect', console.error.bind(console, 'watchify process disconnected'))
    });
};
