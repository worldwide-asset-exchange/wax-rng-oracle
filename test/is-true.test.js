const { expect } = require('chai');
const { isTrue } = require('../lib/config/utils');

// Regression: env-var-driven deployments (custom-environment-variables.json) deliver
// booleans as STRINGS. READONLY_MODE="false" must not read as true — a truthy string
// here silently disabled the poller (no jobs signed) on env-configured deployments.
describe('isTrue config coercion', () => {
  it('treats boolean-ish false strings as false', () => {
    expect(isTrue('false')).to.equal(false);
    expect(isTrue('0')).to.equal(false);
    expect(isTrue('null')).to.equal(false);
    expect(isTrue('undefined')).to.equal(false);
  });

  it('treats true strings as true', () => {
    expect(isTrue('true')).to.equal(true);
    expect(isTrue('1')).to.equal(true);
  });

  it('passes real booleans through', () => {
    expect(isTrue(true)).to.equal(true);
    expect(isTrue(false)).to.equal(false);
  });

  it('treats undefined/null as false', () => {
    expect(isTrue(undefined)).to.equal(false);
    expect(isTrue(null)).to.equal(false);
  });
});
