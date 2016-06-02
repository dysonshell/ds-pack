'use strict';
var path = require('path');
var APP_ROOT = path.resolve(__dirname, '..', '..').replace(/node_modules[\\\/]dysonshell$/, '');
process.env.NODE_CONFIG_DIR = path.join(APP_ROOT, 'config');

var fs = require('fs');
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
var semver = require('semver');
var _ = require('lodash');
var VFile = require('vinyl');
var Promise = require('bluebird');
var respawn = require('respawn');
var mkdirp = require('mkdirp');
var revHash = require('rev-hash');

var unary = require('fn-unary');
var watch = require('gulp-watch');
var babel = require('gulp-babel');
var plumber = require('gulp-plumber');
var notify = require('gulp-notify');
var rimraf = require('rimraf');
var rev = require('gulp-rev');
var file = require('gulp-file');
var factorBundle = require('gulp-factor-bundle');
var uglify = require('gulp-uglify');
var nano = require('gulp-cssnano');
var revOutdated = require('gulp-rev-outdated');
var sourcemaps = require('gulp-sourcemaps');
var jsonlint = require('gulp-jsonlint');

var bufferFile = require('vinyl-fs/lib/src/getContents/bufferFile');

var rewriter = require('rev-rewriter');
var xtend = require('xtend');
var config = require('config')
var cdnDomain = config.cdnDomain;
var dsRewriter= function (revMap, contents) {
    return rewriter({
        revMap: revMap,
        assetPathPrefix: '/',
        revPost: function (p, rewritten) {
            if (!rewritten) {
                return '/' + p;
            }
            var url = p[0] !== '/' ? '/' + p : p;
            if (typeof cdnDomain === 'string') {
                url = '//' + cdnDomain.replace(/^(https?)?\/+|\/+$/i, '') + url;
            }
            return url;
        }
    }, contents);
}

module.exports = function (gulp, opts) {

    // config
    var dot = /^dev(-|$)/.test(process.argv[2]) ? 'dev' : 'tmp';
    var SRC_ROOT = path.join(APP_ROOT, 'src');
    var DOT_ROOT = path.join(APP_ROOT, dot);
    var port, searchPrefix, DSC, DSCns;

    var requiredBy = {}

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

    var files = {};
    var wafiles = ['src/**/*', '!**/*~', '!src/'+DSC+'*/node_modules', '!src/'+DSC+'*/node_modules/**/*'];
    var wnjsfiles = ['src/**/*.js', '!**/*~', '!src/'+DSC+'*/node_modules', '!src/'+DSC+'*/node_modules/**/*'];

    config.dsAppRoot = DOT_ROOT;
    var dsWatchify
    //console.log(JSON.stringify(_.pick(config, Object.keys(config).filter(k => k.match(/^ds/))), null, '    '));
    DSCns = (config.dsComponentPrefix || 'dsc').replace(/^\/+/, '').replace(/\/+$/, '');
    DSC = DSCns + '/';
    port = parseInt(process.env.PORT, 10) || config.port || 4000;
    process.env.PORT = ''+port;

    searchPrefix = (config.dsComponentFallbackPrefix || []).map(p => {
        if (typeof p !== 'string') return false;
        if (p.match(/[-\/]$/)) return p;
        return p.replace(/^\/+/, '') + '/';
    }).filter(Boolean);

    var srcDSC = 'src/' + DSC;
    //console.log(searchPrefix);

    files.a = [
        'src/**/*',
        '' + srcDSC + '*/**/*',
        '!' + srcDSC + 'preload.js',
        '!' + srcDSC + '*/js/**/*.js',
        '' + srcDSC + '*/js/dist/**/*.js',
        '!' + srcDSC + '*/node_modules',
        '!' + srcDSC + '*/node_modules/**/*',
    ];

    files.njs = [
        'src/**/*.js',
        '!src/**/js/dist/**/*.js',
        '!src/**/node_modules/**/*.js',
        '' + srcDSC + '**/*.js',
        '!' + srcDSC + '*/js/**/*.js',
        '!' + srcDSC + 'preload.js',
    ];

    files.bjs = [
        '' + srcDSC + '*/js/**/*.js',
        '!' + srcDSC + '*/js/dist/**/*.js',
        'src/'+DSC+'preload.js',
    ];
    //console.log(files);

    files = _.mapValues(files, function (v) {
        return globby.sync(v, {cwd: APP_ROOT});
    });

    //console.log(files);

    /*
    console.log(afiles, njsfiles, bjsfiles, csfiles);
    console.log([afiles, njsfiles, bjsfiles, csfiles].map(d => globby.sync(d, {cwd: APP_ROOT})));
    */

    function getFallbacks() {
        var fallbacks = {};
        globby.sync(searchPrefix.map(d=>d+'*/'), {cwd:APP_ROOT}).forEach((fpath => {
            var rfp = rmFallbackPath(fpath);
            if (fallbacks[rfp]) {
                return;
            }
            fallbacks[rfp] = fpath;
        }));
        return _.values(fallbacks);
    }

    gulp.task('init', [], function () {
        var fallbacks = getFallbacks();
        var files = globby.sync(_.flatten(fallbacks.map(f => [f+'**/*', '!'+f+'/node_modules/**/*', '!'+f+'/package.json'])), {cwd:APP_ROOT});
        files.forEach(fp => {
            var rfp = rmFallbackPath(fp);
            if (fs.existsSync(path.join(SRC_ROOT, rfp)) &&
                fs.statSync(path.join(SRC_ROOT, rfp)).isFile()) {
            }
        });
        var firstTime;
        var copiedMap = {};
        if (fs.existsSync(path.join(APP_ROOT, 'ds-copied-files.json'))) {
            copiedMap = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'ds-copied-files.json'), 'utf-8'));
        } else {
            firstTime = true;
        }
        var fallbacksVersion = fallbacks.map(fallback => {
            var version = JSON.parse(fs.readFileSync(path.join(APP_ROOT, fallback, 'package.json'))).version;
            return [fallback, version];
        });
        console.log(fallbacksVersion);
        function getVersion(fp) {
            return fallbacksVersion.filter(fv => fp.indexOf(fv[0]) > -1)[0][1];
        }
        return gulp.src(files, {cwd: APP_ROOT})
        .pipe(through.obj(function (file, enc, cb) {
            file.base = APP_ROOT;
            file.relPath = path.relative(file.base, file.path);
            file.destPath = rmFallbackPath(file.relPath);
            file.path = path.join(file.base, 'src', file.destPath);
            fs.exists(file.path, exists => {
                if (!exists) {
                    this.push(file);
                    cb();
                    return;
                }
                if (!firstTime && copiedMap[file.destPath]) {
                    fs.readFile(file.path, (err, buf) => {
                        if (err) {
                            console.log(err.stack);
                            cb();
                            return;
                        }
                        var previousHash = copiedMap[file.destPath].revHash;
                        var previousVersion = copiedMap[file.destPath].fromVersion;
                        // console.log(file.destPath, !!buf, buf.length, !!file.contents);
                        // console.log(previousHash === revHash(buf));
                        if (previousHash === revHash(buf)) {
                            // copied from fallback and not touched
                            file.revHash = revHash(file.contents);
                            file.fromVersion = getVersion(file.relPath);
                            if (file.revHash !== previousHash && semver.lt(previousVersion, file.fromVersion)) {
                                console.log('update', file.destPath);
                                this.push(file);
                            }
                        } else {
                            console.log(file.destPath, 'has been changed, skip update');
                        }
                        cb();
                        //console.log(file.destPath, previousHash, file.revHash);
                    });
                } else {
                    cb();
                }
            });
        }))
        .pipe(through.obj(function (file, enc, cb) {
            if (!file.contents) {
                cb();
                return;
            }
            copiedMap[file.destPath] = {
                copiedFrom: file.relPath,
                fromVersion: file.fromVersion || getVersion(file.relPath),
                revHash: file.revHash || revHash(file.contents),
            };
            this.push(file);
            cb();
        }))
        .pipe(through.obj(function (file, enc, cb) {
            console.log('copy', file.destPath, 'from', file.relPath);
            this.push(file);
            cb();
        }))
        .pipe(dest())
        .on('end', function () {
            fs.writeFileSync(path.join(APP_ROOT, 'ds-copied-files.json'), JSON.stringify(copiedMap, null, '    '), 'utf-8');
            console.log('dysonshell installed components done (re)init.');
        })
    });

    gulp.task('prepare-assets', [], function () {
        return gulp.src(files.a)
            .pipe(aupdated()) //jsonlint
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

    function tJS(plugPlumber) {
        return streamCombine.apply(null, [
            tOrigPath(),
            tBase('src'),
            tBabel(plugPlumber)
        ].concat(plugPlumber
            ? [plumber.stop(), tRmFallbackPath()]
            : [tRmFallbackPath()])
        );
    }

    function tBabel(plugPlumber) {
        var t = through.obj(function (file, enc, cb) {
            if (path.relative(file.base, file.path).match(/\/js\//)) {
                if (path.relative(file.base, file.path).match(/\/js\/dist\//)) {
                    r.push(file);
                } else {
                    b.push(file);
                }
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
        var r = through.obj();
        var n = through.obj();
        t.on('end', b.push.bind(b, null));
        t.on('end', r.push.bind(r, null));
        t.on('end', n.push.bind(n, null));
        ;(plugPlumber ? n.pipe(plumber({errorHandler: errorAlert})) : n)
            .pipe(sourcemaps.init())
            .pipe(babel({
                presets: [require('babel-preset-dysonshell/node-auto')],
            }))
            .pipe(sourcemaps.write())
            .pipe(out);
        ;(plugPlumber ? b.pipe(plumber({errorHandler: errorAlert})) : b)
            .pipe(sourcemaps.init())
            .pipe(babel({
                presets: [require('babel-preset-dysonshell')],
            }))
            .pipe(sourcemaps.write())
            .pipe(out);
        r.pipe(out);
        return t;
    }

    gulp.task('prepare-js', ['prepare-assets'], function () {
        return es.merge([
            gulp.src(files.njs).pipe(tJS()),
            gulp.src(files.bjs).pipe(tJS()),
        ])
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, ']\n    compiled from [', file.origPath, ']');
            })
    });

    function symlink(sdir) {
        getFallbacks().forEach(fp => {
            var pta = path.join.bind(path, APP_ROOT);
            var sourceDir = pta(sdir, rmFallbackPath(fp));
            if (!fs.existsSync(sourceDir)) {
                return;
            }
            var source = path.join(sourceDir, 'node_modules');
            var targetAbsolutePath = pta(fp, 'node_modules');
            rimraf.sync(source);
            if (!fs.existsSync(targetAbsolutePath)) {
                return;
            }
            var target = path.relative(sourceDir, targetAbsolutePath);
            fs.symlinkSync(target, source, 'dir');
        });
    }

    gulp.task('prepare', ['prepare-js', 'prepare-assets'], function () {
        symlink(dot);
        dsWatchify = require('./watchify')
        return gulp.src([
            'src/'+DSC+'**',
            '!**/*.js',
            '!src/'+DSC+'*/node_modules',
            '!src/'+DSC+'*/node_modules/**/*'
        ], {cwd: APP_ROOT})
            .pipe(tBase('src'))
            .pipe(dest(dot));
    });

    gulp.task('prepare-build', ['prepare'], function () {
        globby.sync(['**/*.js', '!'+DSC+'global-*.js', '!'+DSC+'common-*.js', '!'+DSC+'*/js/**/*.js'], {cwd: path.join(APP_ROOT, 'dist')}).forEach(function (fp) {
            rimraf.sync(path.join(APP_ROOT, 'dist', fp));
        });
        return gulp.src(['**/*', '!'+DSC+'*/node_modules', '!'+DSC+'*/node_modules/**/*'], {cwd: DOT_ROOT})
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

        return src([DSC+'preload.js', DSC+'*/img/**', DSC+'*/js/dist/**/*.js'])
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
            filepath.indexOf('/.tmp/') === 0 ||
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

    gulp.task('build-global-js', ['build-assets'], function() {
        return Promise.coroutine(function *() {
            var globalSrc =
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
            fs.writeFileSync(path.join(DOT_ROOT, DSC, 'global.js'), globalSrc, 'utf-8')
        });
    });

    gulp.task('build-nonmain-js', ['build-css', 'build-global-js'], function () {
        var bcp = fs.readFileSync(require.resolve('browserify-common-prelude/dist/bcp.min.js'), 'utf-8');
        var files = glob.sync(DSC+'*/js/main/**/*.js', {
            cwd: DOT_ROOT,
        }).map(unary(path.join.bind(path, DOT_ROOT)));
        //var globalJsSrc = fs.readFileSync(require.resolve('@ds/common/dist/'+DSC+'global.js'), 'utf8');
        return src([
            DSC+'global.js',
            DSC+'*/js/**/*.js',
            '!'+DSC+'*/js/main/**',
        ])
            .pipe(through.obj(function (file, enc, done) {
                var filePath = path.relative(DOT_ROOT, file.path)
                console.log('trying to uglify js file: ' + filePath, 'base:', file.base);
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
                var filePath = path.relative(DOT_ROOT, file.path)
                console.log('trying to browserify js file: ' + filePath);
                var t = this
                dsWatchify.bundle(filePath, {
                    watch: false,
                })
                .then(function (src) {
                    file.contents = src
                    t.push(file);
                    done()
                })
                .catch(function (err) {
                    t.emit('error', err)
                    done()
                });
            }))
            .pipe(tReplaceTmp())
            .pipe(through.obj(function (file, enc, done) {
                var filePath = path.relative(DOT_ROOT, file.path)
                console.log('trying to uglify js file: ' + filePath);
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
        return src([DSC+'**/*.html'])
            .pipe(tBase(dot))
            .pipe(through.obj(function (file, enc, cb) {
                var contents = file.contents.toString();
                console.log('- revving template: ', file.path);
                contents = dsRewriter(revMap, contents);
                file.contents = new Buffer(contents);
                // file.contents = new Buffer(dsRewriter(revMap, obj.contents.toString('utf-8')));
                this.push(file);
                cb();
            }))
            .pipe(dest('dist'));
    });

    gulp.task('build', ['build-rev'], function () {
        symlink('dist');
    });

    function exists(filePath) {
        return new Promise(function (resolve) {
            fs.exists(filePath, resolve);
        });
    }

    function aupdated(ignoreJsCoffee) {
        return through.obj(function (file, enc, cb) {
            var tIn = through.obj();
            var tOut = through.obj((file, enc, innercb) => {
                if (file.jsonlint.success) {
                    this.push(file);
                } else {
                    this.emit('error', new Error('\n' + file.path + '\n' + file.jsonlint.message));
                }
                innercb();
                cb();
            });
            if (file.path.match(/\.(json)$/i)) {
                tIn.push(file);
            } else {
                if (!ignoreJsCoffee || !file.path.match(/\.js$/i)) {
                    this.push(file);
                }
                cb();
            }
            tIn
                .pipe(jsonlint())
                .pipe(tOut);
        });
    }

    gulp.task('dev', ['prepare'], function () {
        var m = respawn([process.execPath, path.join(DOT_ROOT, 'index.js')], {
            cwd: DOT_ROOT,
            env: xtend(process.env, {
                NODE_ENV: 'development',
                NODE_CONFIG: '{"dsAppRoot":"'+DOT_ROOT+'"}',
            }),
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
            var paths = [
                path.join(SRC_ROOT, DSC, relativeFilePathWithoutExt + '.js'),
            ];
            paths.push(
                path.join(SRC_ROOT, DSC, 'index.js'),
                path.join(SRC_ROOT, 'index.js')
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
        var jsupdate = through.obj();
        var jsupdated = jsupdate.pipe(through.obj(function (file, enc, cb) {
            fs.exists(file.path, exists => {
                if (exists) {
                    this.push(file);
                } else {
                    fs.unlink(path.join(DOT_ROOT, path.relative(SRC_ROOT, file.path)), (err) => {
                        console.error(err);
                        getAvailableFallbackFile(file.path).then(filePath => {
                            jsupdate.push(new VFile({
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

        watch(wnjsfiles, {cwd: APP_ROOT})
            .pipe(jsupdated)
            .on('data', function (file) {
                console.log('- [', file.path, '] updated');
            })
            .pipe(readFileThrough())
            .pipe(tBabel(true))
            .pipe(tBase('src'))
            .pipe(tRmFallbackPath())
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, '] babel compiled');
                if (path.relative(file.base, file.path).indexOf('/js/') > -1) {
                    if (gulp.browserSync) {
                      gulp.browserSync.reload();
                    }
                } else {
                    m.stop(function() {
                        m.start()
                    })
                }
            });

        watch(wafiles, {cwd: APP_ROOT})
            .pipe(plumber({errorHandler: errorAlert}))
            .pipe(aupdated(true))
            .pipe(plumber.stop())
            .on('data', function (file) {
                console.log('- [', file.path, '] updated');
            })
            .pipe(tBase('src'))
            .pipe(dest(dot))
            .on('data', function (file) {
                console.log('- [', file.path, '] copied');
                if (gulp.browserSync) {
                  gulp.browserSync.reload();
                }
            });

        var fork = require('child_process').fork;

        var w = fork(path.resolve(__dirname, './server.js'), {
            env: xtend(process.env, {
                NODE_ENV: 'development',
                NODE_CONFIG: '{"dsAppRoot":"'+DOT_ROOT+'"}',
            }),
            stdio: 'inherit',
        });
        w.on('error', errorAlert);
        w.on('error', console.error.bind(console, 'watchify process error'))
        w.on('close', console.error.bind(console, 'watchify process closed'))
        w.on('disconnect', console.error.bind(console, 'watchify process disconnected'))
    });
};
