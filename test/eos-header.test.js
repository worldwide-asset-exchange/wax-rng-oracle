const assert = require('chai').assert;
const nock = require('nock');
const config = require('../lib/config/configLoader').loadConfig();
const { eosRpc } = require('../lib/config/eos');

// Check if @waxio/fetch-retry is available
let hasWaxioFetchRetry = false;
try {
  require('@waxio/fetch-retry');
  hasWaxioFetchRetry = true;
} catch (err) {
  // Not available, will skip related tests
}

describe('EOS RPC Headers', function() {
  it('Should include X-WAX-Source header in requests', async function() {
    if (!hasWaxioFetchRetry) {
      this.skip(); // Skip test when @waxio/fetch-retry is not available
    }

    this.timeout(10000);

    let requestHeaders;
    nock(config.eos.apiUrl)
      .post('/v1/chain/get_table_rows')
      .query(true)
      .reply(function(uri, requestBody) {
        requestHeaders = this.req.headers;
        return [
          200,
          {
            rows: [],
            more: false,
            next_key: '',
          },
        ];
      });

    await eosRpc.get_table_rows({
      json: true,
      code: 'eosio',
      scope: 'eosio',
      table: 'abihash',
      limit: 1,
    });

    assert.equal(requestHeaders['x-wax-source'], 'orng-oracle');
  });
});
