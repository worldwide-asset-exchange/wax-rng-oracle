const { expect } = require('chai');
const sinon = require('sinon');
const Module = require('module');

const LOADER_PATH = require.resolve('../lib/config/configLoader');

// Env vars whose presence tells the shim "this deployment expects secrets" —
// with any of them set, a missing wax-config must fail the boot, never silently
// fall back to plain config.
const SECRETS_INTENT_ENVS = [
  'SECRETS_MANAGER_SECRET_ID',
  'ENCRYPTED_KEYS',
  'WAX_CONFIG_REQUIRE_RESOLUTION',
];

// The shim memoizes its instance in module scope, so each test needs a FRESH copy.
// We intercept Module._load (the same technique wax-config's own smoke tests use)
// to substitute @waxio/wax-config, and restore the loader's original cache entry
// afterwards so the singleton other suites share is untouched.
describe('configLoader shim', () => {
  const realLoad = Module._load;
  let originalCacheEntry;
  let savedEnv;

  before(() => {
    // Captured at RUN time, not file-load time: other test files loaded after this
    // one create the real cache entry at module scope, and a load-time snapshot
    // would make afterEach delete their live entry instead of restoring it.
    originalCacheEntry = require.cache[LOADER_PATH];
  });

  beforeEach(() => {
    savedEnv = {};
    for (const name of SECRETS_INTENT_ENVS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  function loadFreshLoaderWith(waxConfigBehaviour) {
    Module._load = function(request, parent, isMain) {
      if (request === '@waxio/wax-config') {
        return waxConfigBehaviour();
      }
      return realLoad.apply(this, arguments);
    };
    delete require.cache[LOADER_PATH];
    return require(LOADER_PATH);
  }

  function moduleNotFound(message) {
    const err = new Error(message);
    err.code = 'MODULE_NOT_FOUND';
    return err;
  }

  afterEach(() => {
    Module._load = realLoad;
    if (originalCacheEntry) {
      require.cache[LOADER_PATH] = originalCacheEntry;
    } else {
      delete require.cache[LOADER_PATH];
    }
    for (const name of SECRETS_INTENT_ENVS) {
      if (savedEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[name];
      }
    }
  });

  it('passes { cluster: true } to wax-config so cluster workers resolve over IPC, not AWS', () => {
    const fakeInstance = { get: () => 'value', has: () => true };
    const loadConfigStub = sinon.stub().returns(fakeInstance);
    const loader = loadFreshLoaderWith(() => ({ loadConfig: loadConfigStub }));

    const config = loader.loadConfig();

    expect(loadConfigStub.calledOnce).to.equal(true);
    expect(loadConfigStub.firstCall.args[0]).to.deep.equal({ cluster: true });
    expect(config).to.equal(fakeInstance);
  });

  it('memoizes the instance — wax-config is only consulted once', () => {
    const loadConfigStub = sinon.stub().returns({ get: () => 'value' });
    const loader = loadFreshLoaderWith(() => ({ loadConfig: loadConfigStub }));

    const first = loader.loadConfig();
    const second = loader.loadConfig();

    expect(second).to.equal(first);
    expect(loadConfigStub.calledOnce).to.equal(true);
  });

  it('falls back to the plain config library when wax-config is not installed (open-source usage)', () => {
    const loader = loadFreshLoaderWith(() => {
      throw moduleNotFound("Cannot find module '@waxio/wax-config'");
    });

    const config = loader.loadConfig();

    // The standard `config` package instance: readable and NOT our fake.
    expect(config).to.equal(require('config'));
  });

  it('refuses the fallback when the deployment expects secrets (fails the boot loudly)', () => {
    for (const name of SECRETS_INTENT_ENVS) {
      process.env[name] = name === 'ENCRYPTED_KEYS' ? 'secret1' : 'true';
      const loader = loadFreshLoaderWith(() => {
        throw moduleNotFound("Cannot find module '@waxio/wax-config'");
      });

      expect(() => loader.loadConfig(), `with ${name} set`).to.throw(
        /expects @waxio\/wax-config/
      );

      delete process.env[name];
    }
  });

  it('rethrows MODULE_NOT_FOUND for a missing transitive dependency instead of falling back', () => {
    // wax-config IS installed but broken (e.g. a partial node_modules missing one
    // of its own deps) — treating that as "not installed" would silently boot a
    // custody deployment on placeholder secrets.
    const loader = loadFreshLoaderWith(() => {
      throw moduleNotFound("Cannot find module 'import-fresh'");
    });

    expect(() => loader.loadConfig()).to.throw(/import-fresh/);
  });

  it('rethrows real wax-config failures instead of masking them as the fallback', () => {
    const loader = loadFreshLoaderWith(() => {
      throw new Error('secret resolution is REQUIRED but ...');
    });

    expect(() => loader.loadConfig()).to.throw('REQUIRED');
  });
});
