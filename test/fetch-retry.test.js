const assert = require('chai').assert;
const fetchRetryFactory = require('../lib/config/fetchRetry').default;

const res = status => ({ status });
const sysErr = code => Object.assign(new Error(code), { code });

// A scripted fetch: each call consumes the next step (a status, an error, or 'hang').
function scripted(steps) {
  const calls = [];
  const fn = (url, opts) => {
    calls.push(opts);
    const step = steps[calls.length - 1];
    if (step === 'hang') {
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () =>
          reject(
            Object.assign(new Error('The user aborted a request.'), {
              type: 'aborted',
            })
          )
        );
      });
    }
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(res(step));
  };
  fn.calls = calls;
  return fn;
}

describe('fetchRetry', function() {
  this.timeout(10000);

  it('returns the first 2xx response', async function() {
    const f = scripted([200]);
    const r = await fetchRetryFactory(5, 1000, f)('http://x');
    assert.equal(r.status, 200);
    assert.equal(f.calls.length, 1);
  });

  it('maxTry is the TOTAL number of attempts', async function() {
    const f = scripted([
      sysErr('ECONNRESET'),
      sysErr('ECONNRESET'),
      sysErr('ECONNRESET'),
    ]);
    try {
      await fetchRetryFactory(3, 1000, f)('http://x');
      assert.fail('should throw');
    } catch (e) {
      assert.equal(e.code, 'ECONNRESET');
    }
    assert.equal(f.calls.length, 3);
  });

  it('retries a non-2xx and returns the last one as-is', async function() {
    const f = scripted([500, 502, 503]);
    const r = await fetchRetryFactory(3, 1000, f)('http://x');
    assert.equal(r.status, 503);
    assert.equal(f.calls.length, 3);
  });

  it('recovers when a later attempt succeeds', async function() {
    const f = scripted([500, sysErr('ETIMEDOUT'), 200]);
    const r = await fetchRetryFactory(5, 1000, f)('http://x');
    assert.equal(r.status, 200);
    assert.equal(f.calls.length, 3);
  });

  it('retries only the four retryable network codes', async function() {
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
    ]) {
      const f = scripted([sysErr(code), 200]);
      const r = await fetchRetryFactory(2, 1000, f)('http://x');
      assert.equal(r.status, 200, code);
    }
  });

  it('reads the code from err.cause (native fetch shape)', async function() {
    const e = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const f = scripted([e, 200]);
    const r = await fetchRetryFactory(2, 1000, f)('http://x');
    assert.equal(r.status, 200);
  });

  it('throws a non-retryable error at once', async function() {
    const f = scripted([sysErr('EPROTO'), 200]);
    try {
      await fetchRetryFactory(5, 1000, f)('http://x');
      assert.fail('should throw');
    } catch (e) {
      assert.equal(e.code, 'EPROTO');
    }
    assert.equal(f.calls.length, 1);
  });

  it('aborts a hung attempt after the timeout and retries', async function() {
    const f = scripted(['hang', 200]);
    const t0 = Date.now();
    const r = await fetchRetryFactory(2, 200, f)('http://x');
    assert.equal(r.status, 200);
    assert.isAtLeast(Date.now() - t0, 190);
  });

  it('reports "request <url> timeout" when the last attempt timed out', async function() {
    const f = scripted(['hang', 'hang']);
    try {
      await fetchRetryFactory(2, 100, f)('http://chain/v1/x');
      assert.fail('should throw');
    } catch (e) {
      assert.equal(e.message, 'request http://chain/v1/x timeout');
    }
  });

  it('passes headers and body through, with its own abort signal', async function() {
    const f = scripted([200]);
    await fetchRetryFactory(
      1,
      1000,
      f
    )('http://x', {
      method: 'POST',
      headers: { 'X-WAX-Source': 'orng-oracle' },
      body: '{}',
    });
    assert.equal(f.calls[0].method, 'POST');
    assert.equal(f.calls[0].headers['X-WAX-Source'], 'orng-oracle');
    assert.ok(f.calls[0].signal);
  });

  it('defaults to 5 attempts and a 5000 ms timeout', function() {
    const m = require('../lib/config/fetchRetry');
    assert.equal(m.DEFAULT_MAX_TRY, 5);
    assert.equal(m.DEFAULT_TIMEOUT_MS, 5000);
  });
});
