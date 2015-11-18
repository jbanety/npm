var Promise = require('rsvp').Promise;
var asp = require('rsvp').denodeify;
var request = require('request');
var zlib = require('zlib');
var tar = require('tar');
var url = require('url');
var fs = require('graceful-fs');
var path = require('path');
var mkdirp = require('mkdirp');
var Npmrc = require('./npmrc');
var auth = require('./auth');

var nodeSemver = require('semver');
var nodeConversion = require('./node-conversion');
var Npmrc = require('./npmrc');

var defaultRegistry = 'https://registry.npmjs.org';

function clone(a) {
  var b = {};
  for (var p in a) {
    if (a[p] instanceof Array)
      b[p] = [].concat(a[p]);
    else if (typeof a[p] == 'object')
      b[p] = clone(a[p]);
    else
      b[p] = a[p];
  }
  return b;
}

var NPMLocation = function(options, ui) {
  this.ui = ui;
  this.name = options.name;

  var npmrc = new Npmrc();

  this.registryURL = function (scope) {
    return scope && npmrc.getRegistry(scope) || options.registry || npmrc.getRegistry() || defaultRegistry;
  };

  this.tmpDir = options.tmpDir;
  this.remote = options.remote;
  this.strictSSL = 'strictSSL' in options ? options.strictSSL : true;

  // cache versioning scheme used for patches
  // this.versionString = options.versionString + '.1';

  if (options.username && !options.auth)
    options.auth = auth.encodeCredentials(options.username, options.password);
  // NB eventual auth deprecation
  // delete options.username;
  // delete options.password;

  if (options.authToken)
    this.auth = { token: options.authToken };
  else if (options.auth)
    this.auth = auth.decodeCredentials(options.auth);
  else
    this.auth = npmrc.getAuth(this.registryURL());

  // only alwaysAuth when the registryURL is not the defaultRegistry
  // otherwise we just auth for scopes
  this.alwaysAuth = this.registryURL() != defaultRegistry;
};

NPMLocation.configure = function(config, ui) {
  config.remote = config.remote || 'https://npm.jspm.io';

  var npmrc = new Npmrc();
  var npmrcAuth;

  var registry;

  return Promise.resolve()
  .then(function() {
    var customMsg;
    if (config.registry && (config.auth || config.authToken))
      customMsg = 'a custom registry and credentials';
    else if (config.registry)
      customMsg = 'a custom registry';
    else if (config.auth || config.authToken)
      customMsg = 'custom credentials';

    if (customMsg)
      return ui.confirm('Currently using ' + customMsg + '. Would you like to reset to npmrc defaults?', false);
  })
  .then(function(reset) {
    if (reset) {
      delete config.registry;
      delete config.auth;
      delete config.authToken;
    }
    return ui.input('npm registry', config.registry || npmrc.getRegistry() || defaultRegistry);
  })
  .then(function(_registry) {
    registry = _registry;
    if (registry != (npmrc.getRegistry() || defaultRegistry))
      config.registry = registry.replace(/\/$/, '');

    npmrcAuth = npmrc.getAuth(config.registry);

    if (config.auth || config.authToken)
      return ui.confirm('Custom authentication currently configured, reconfigure credentials?', false);
    else if (npmrcAuth)
      return ui.confirm('Currently reading credentials from npmrc, configure custom authentication?', false);
    else
      return ui.confirm('No authentication configured, configure credentials?', false);
  })
  .then(function(doAuth) {
    if (!doAuth)
      return;

    return auth.configureCredentials(registry,
        config.authToken && { token: config.authToken } || config.auth && auth.decodeCredentials(config.auth) || npmrcAuth, ui)
    .then(function(_auth) {
      delete config.auth;
      delete config.authToken;

      if (_auth.token)
        config.authToken = _auth.token;
      else if (_auth.username && _auth.password)
        config.auth = auth.encodeCredentials(_auth);
    });
  })
  .then(function() {
    return config;
  });
};

NPMLocation.packageNameFormats = ['@*/*', '*'];

NPMLocation.prototype = {

  lookup: function(repo) {
    var self = this;

    var newLookup = false;
    var lookupCache;
    var latestKey = 'latest';
    var repoPath = repo[0] == '@' ? '@' + encodeURIComponent(repo.substr(1)) : encodeURIComponent(repo);

    var doAuth = this.alwaysAuth || repo[0] == '@';

    return asp(fs.readFile)(path.resolve(self.tmpDir, repo + '.json'))
    .then(function(lookupJSON) {
      lookupCache = JSON.parse(lookupJSON.toString());
    }).catch(function(e) {
      if (e.code == 'ENOENT' || e instanceof SyntaxError)
        return;
      throw e;
    })
    .then(function() {
      var scope;
      if (repo[0] === '@') {
        var scopeMatch = repo.match(/^(@.*)\//);
        if (scopeMatch[1]) {
          scope = scopeMatch[1];
        }
      }
      return asp(request)(auth.injectRequestOptions({
        uri: self.registryURL(scope) + '/' + repoPath,
        strictSSL: self.strictSSL,
        headers: lookupCache ? {
          'if-none-match': lookupCache.eTag
        } : {}
      }, doAuth && self.auth)).then(function(res) {
        if (res.statusCode == 304)
          return { versions: lookupCache.versions,
                   latest: lookupCache.latest };

        if (res.statusCode == 404)
          return { notfound: true };

        if (res.statusCode == 401)
          throw 'Invalid authentication details. Run %jspm registry config ' + self.name + '% to reconfigure.';

        if (res.statusCode != 200)
          throw 'Invalid status code ' + res.statusCode;

        var versions = {};
        var latest;
        var packageData;

        try {
          var json = JSON.parse(res.body);
          var distTags = json['dist-tags'] || {};
          packageData = json.versions;
          latest = distTags[latestKey];
        }
        catch(e) {
          throw 'Unable to parse package.json';
        }

        for (var v in packageData) {
          if (packageData[v].dist && packageData[v].dist.shasum)
            versions[v] = {
              hash: packageData[v].dist.shasum,
              meta: packageData[v],
              stable: !packageData[v].deprecated
            };
        }

        if (res.headers.etag) {
          newLookup = true;
          lookupCache = {
            eTag: res.headers.etag,
            versions: versions,
            latest: latest,
          };
        }

        return { versions: versions,
                 latest: latest };
      });
    })
    .then(function(response) {
      // save lookupCache
      if (newLookup) {
        var lookupJSON = JSON.stringify(lookupCache);
        var outputPath = path.resolve(self.tmpDir, repo + '.json');
        return asp(mkdirp)(path.dirname(outputPath))
        .then(function() {
          return asp(fs.writeFile)(outputPath, lookupJSON);
        })
        .then(function() {
          return response;
        });
      }

      return response;
    });
  },

  getPackageConfig: function(repo, version, hash, packageConfig) {
    if (!packageConfig)
      throw 'Package.json meta not provided in endpoint request';

    if (hash && packageConfig.dist.shasum != hash)
      throw 'Package.json lookup hash mismatch';

    return clone(packageConfig);
  },

  processPackageConfig: function(packageConfig, packageName) {
    if (packageConfig.jspmNodeConversion === false)
      return packageConfig;

    // warn if using jspm-style dependencies at this point
    for (var d in packageConfig.dependencies)
      checkDependency(d, packageConfig.dependencies[d]);
    for (var d in packageConfig.peerDependencies)
      checkDependency(d, packageConfig.peerDependencies[d]);

    function checkDependency(d, dep) {
      if (!dep.match(/^(https?|git)[:+]/) && dep.indexOf(':') > 0)
        throw 'Package.json dependency %' + d + '% set to `' + dep + '`, which is not a valid dependency format for npm.'
          + '\nIt\'s advisable to publish jspm-style packages to GitHub or another `registry` so conventions are clear.';
          + '\nTo skip npm compatibility install with %jspm install ' + packageName + '-o "{jspmNodeConversion: false}"%.'
    }

    packageConfig.dependencies = parseDependencies(packageConfig.dependencies, this.ui);
    packageConfig.peerDependencies = parseDependencies(packageConfig.peerDependencies, this.ui);

    if (packageConfig.main instanceof Array)
      ui.log('warn', 'Package `' + packageName + '` has a main array, which is not supported.');

    // every npm package depends on github:jspm/nodelibs as a peer dependency
    if (!packageConfig.dependencies['nodelibs'] && !packageConfig.peerDependencies['nodelibs'])
      packageConfig.peerDependencies['nodelibs'] = 'github:jspm/nodelibs@^0.1.0';

    // ignore directory flattening for NodeJS, as npm doesn't do it
    // we do allow if there was an override through the jspm property though
    if (!packageConfig.jspm || !packageConfig.jspm.directories)
      delete packageConfig.directories;

    // ignore node_modules and test folders by default
    if (!(packageConfig.ignore instanceof Array))
      packageConfig.ignore = [];
    packageConfig.ignore.push('node_modules', 'test');

    // keep the package.json around if we're doing files filtering
    if (packageConfig.files && packageConfig.files instanceof Array && packageConfig.files.indexOf('package.json') == -1)
      packageConfig.files.push('package.json');

    return packageConfig;
  },

  download: function(repo, version, hash, versionData, targetDir) {
    var self = this;

    var doAuth = this.alwaysAuth || repo[0] == '@';

    // Forcing protocol and port matching for tarballs on the same host as the
    // registry is taken from npm at
    // https://github.com/npm/npm/blob/50ce116baac8b6877434ace471104ec8587bab90/lib/cache/add-named.js#L196-L208
    var tarball = url.parse(versionData.dist.tarball);
    var registry = url.parse(this.registryURL());

    if (tarball.hostname === registry.hostname && tarball.protocol !== registry.protocol) {
      tarball.protocol = registry.protocol;
      tarball.port = registry.port;
    }
    tarball = url.format(tarball);

    return new Promise(function(resolve, reject) {
      request(auth.injectRequestOptions({
        uri: tarball,
        headers: { 'accept': 'application/octet-stream' },
        strictSSL: self.strictSSL
      }, doAuth && self.auth))
      .on('response', function(npmRes) {

        if (npmRes.statusCode != 200)
          return reject('Bad response code ' + npmRes.statusCode);

        if (npmRes.headers['content-length'] > 50000000)
          return reject('Response too large.');

        npmRes.pause();

        var gzip = zlib.createGunzip();

        npmRes
        .pipe(gzip)
        .pipe(tar.Extract({
          path: targetDir, 
          strip: 1, 
          filter: function() {
            return !this.type.match(/^.*Link$/);
          }
        }))
        .on('error', reject)
        .on('end', resolve);

        npmRes.resume();
      })
      .on('error', function(error) {
        if (typeof error == 'string') {
          error = new Error(error);
          error.hideStack = true;
        }
        error.retriable = true;
        reject(error);
      });
    });
  },

  processPackage: function(packageConfig, packageName, packageDir) {
    if (packageConfig.jspmNodeConversion === false)
      return packageConfig;

    if (!packageConfig.name)
      packageConfig.name = packageName.substring(packageName.indexOf(':') + 1, packageName.indexOf('@'));

    // apply static conversions
    return nodeConversion.convertPackage(packageConfig, packageDir, this.ui);
  }
};

// convert NodeJS or Bower dependencies into jspm-compatible dependencies
var githubRegEx = /^git(\+[^:]+)?:\/\/github.com\/(.+)/;
var githubHttpRegEx = /^https?:\/\/github\.com\/([^\/]+\/[^\/]+)\/archive\/([^\/]+)\.(tar\.gz|zip)$/;
var protocolRegEx = /^[^\:\/]+:\/\//;
var semverRegEx = /^(\d+)(?:\.(\d+)(?:\.(\d+)(?:-([\da-z-]+(?:\.[\da-z-]+)*)(?:\+([\da-z-]+(?:\.[\da-z-]+)*))?)?)?)?$/i;
function parseDependencies(dependencies, ui) {
  // do dependency parsing
  var outDependencies = {};
  var process = function(d) {
    var dep = dependencies[d];

    var match, name, version = '';

    // 1. git://github.com/name/repo.git#version -> github:name/repo@version
    if ((match = dep.match(githubRegEx))) {
      dep = match[2];
      name = 'github:' + dep.split('#')[0];
      version = dep.split('#')[1] || '*';
      if (version.substr(0, 1) == 'v' && version.substr(1).match(semverRegEx))
        version = version.substr(1);
      if (name.substr(name.length - 4, 4) == '.git')
        name = name.substr(0, name.length - 4);
      ui.log('warn', 'npm dependency `' + name + '@' + version + '` will likely only work if its GitHub repo has %registry: npm% in its package.json');
    }

    // 2. https?://github.com/name/repo/archive/v?[semver].tar.gz -> github:name/repo@[semver]
    else if ((match = dep.match(githubHttpRegEx))) {
      name = 'github:' + match[1];
      version = match[2];
      if (version.substr(0, 1) == 'v' && version.substr(1).match(semverRegEx))
        version = version.substr(1);
    }

    // 3. url:// -> not supported
    else if (dep.match(protocolRegEx))
      throw 'npm dependency format ' + dep + ' not currently supported by jspm. Post an issue if required.';

    // 4. name/repo#version -> github:name/repo@version
    else if (dep.split('/').length == 2) {
      name = 'github:' + dep.split('#')[0];
      version = dep.split('#')[1] || '*';
    }

    // 5. version -> name@version
    else {
      name = d;
      version = dep;
    }

    // otherwise, we convert an npm range into something jspm-compatible
    // if it is an exact semver, or a tag, just use it directly
    if (!nodeSemver.valid(version)) {
      var range;

      // comma space is allowed on npm for some reason
      version = version.replace(/, /g, ' ');

      if (!version || version == 'latest' || version == '*')
        version = '*';

      // if we have a semver or fuzzy range, just keep as-is
      else if (version.indexOf(/[ <>=]/) != -1 || !version.substr(1).match(semverRegEx) || !version.substr(0, 1).match(/[\^\~]/))
        range = nodeSemver.validRange(version);

      if (range == '*')
        version = '*';

      else if (range) {
        // if it has OR semantics, we only support the last range
        if (range.indexOf('||') != -1)
          range = range.split('||').pop();

        var rangeParts = range.split(' ');

        // convert AND statements into a single lower bound and upper bound
        // enforcing the lower bound as inclusive and the upper bound as exclusive
        var lowerBound, upperBound, lEq, uEq;
        for (var i = 0; i < rangeParts.length; i++) {
          var part = rangeParts[i];
          var a = part.charAt(0);
          var b = part.charAt(1);

          // get the version
          var v = part;
          if (b == '=')
            v = part.substr(2);
          else if (a == '>' || a == '<' || a == '=')
            v = part.substr(1);

          // and the operator
          var gt = a == '>';
          var lt = a == '<';

          if (gt) {
            // take the highest lower bound
            if (!lowerBound || nodeSemver.gt(lowerBound, v)) {
              lowerBound = v;
              lEq = b == '=';
            }
          }
          else if (lt) {
            // take the lowest upper bound
            if (!upperBound || nodeSemver.lt(upperBound, v)) {
              upperBound = v;
              uEq = b == '=';
            }
          }
          else {
            // equality
            lowerBound = upperBound = (part.substr(0, 1) == '=' ? part.substr(1) : part);
            lEq = uEq = true;
            break;
          }
        }

        // for some reason nodeSemver adds "-0" when not appropriate
        if (lowerBound && lowerBound.substr(lowerBound.length - 2, 2) == '-0')
          lowerBound = lowerBound.substr(0, lowerBound.length - 2);
        if (upperBound && upperBound.substr(upperBound.length - 2, 2) == '-0')
          upperBound = upperBound.substr(0, upperBound.length - 2);

        var lowerSemver, upperSemver;

        if (lowerBound) {
          lowerSemver = lowerBound.match(semverRegEx);
          lowerSemver[1] = parseInt(lowerSemver[1], 10);
          lowerSemver[2] = parseInt(lowerSemver[2], 10);
          lowerSemver[3] = parseInt(lowerSemver[3], 10);
          if (!lEq) {
            if (!lowerSemver[4])
              lowerSemver[4] = '0';
            // NB support incrementing existing preleases
          }
        }

        if (upperBound) {
          upperSemver = upperBound.match(semverRegEx);
          upperSemver[1] = parseInt(upperSemver[1], 10);
          upperSemver[2] = parseInt(upperSemver[2], 10);
          upperSemver[3] = parseInt(upperSemver[3], 10);
        }

        if (!upperBound && !lowerBound) {
          version = '';
        }

        // if not upperBound, then just treat as a wildcard
        else if (!upperBound) {
          version = '*';
        }

        // if no lowerBound, use the upperBound directly, with sensible decrementing if necessary
        else if (!lowerBound) {

          if (uEq) {
            version = upperBound;
          }

          else {
            if (!upperSemver[4]) {
              if (upperSemver[3] > 0) {
                upperSemver[3]--;
              }
              else if (upperSemver[2] > 0) {
                upperSemver[2]--;
                upperSemver[3] = 0;
              }
              else if (upperSemver[1] > 0) {
                upperSemver[1]--;
                upperSemver[2] = 0;
                upperSemver[3] = 0;
              }
            }
            else {
              upperSemver[4] = undefined;
            }
            version = getVersion(upperSemver);
          }
        }

        else {
          // if upper bound is inclusive, use it
          if (uEq)
            version = upperBound;

          // if upper bound is exact major
          else if (upperSemver[2] === 0 && upperSemver[3] === 0 && !upperSemver[4]) {

            // if previous major is 0
            if (upperSemver[1] - 1 === 0) {
              version = '0';
            }
            else {
              // if lower bound is major below, we are semver compatible
              if (lowerSemver[1] == upperSemver[1] - 1)
                version = '^' + getVersion(lowerSemver);
              // otherwise we are semver compatible with the previous exact major
              else
                version = '^' + (upperSemver[1] - 1);
            }
          }
          // if upper bound is exact minor
          else if (upperSemver[3] === 0 && !upperSemver[4]) {
            // if lower bound is minor below, we are fuzzy compatible
            if (lowerSemver[2] == upperSemver[2] - 1)
              version = '~' + getVersion(lowerSemver);
            // otherwise we are fuzzy compatible with previous
            else
              version = '~' + upperSemver[1] + '.' + (upperSemver[2] - 1) + '.0';
          }
          // if upper bound is exact version -> use exact
          else
            throw 'Unable to translate npm version ' + version + ' into a jspm range.';
        }
      }
    }

    outDependencies[d] = name + (version ? '@' + version : '');
  };
  for (var d in dependencies) process(d);
  return outDependencies;
}
// export for unit testing
NPMLocation.parseDependencies = parseDependencies;

function getVersion(semver) {
  return semver[1] + '.' + semver[2] + '.' + semver[3] + (semver[4] ? '-' + semver[4] : '');
}

module.exports = NPMLocation;