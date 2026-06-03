const crypto = require('crypto');
const { getOrngContract } = require('../lib/config/eos');
const { Chain, Account } = require('qtest-js');
let config = require('../lib/config/configLoader').loadConfig();

let currentIncreasementSigningValue = 0;
const PUBKEY = config.get('shareKey.publicKey');

function sha256(str) {
  return crypto
    .createHash('sha256')
    .update(str)
    .digest('hex');
}

async function createJobs(orngContract, dappContract, numberOfJobs) {
  let jobs = [];
  for (let i = 0; i < numberOfJobs; i++) {
    jobs.push({
      assoc_id: currentIncreasementSigningValue,
      signing_value: currentIncreasementSigningValue + 1,
      caller: dappContract.name,
    });
    await orngContract.contract.action.requestrand(
      {
        assoc_id: currentIncreasementSigningValue++,
        signing_value: currentIncreasementSigningValue,
        caller: dappContract.name,
      },
      [
        {
          actor: dappContract.name,
          permission: 'active',
        },
      ]
    );
  }
  return jobs;
}

async function setupOrngContract(chain, eosRpc) {
  let orngContract = 'orng.wax';
  let orngOracle = 'oracle.wax';
  let orngV1Oracle = 'oraclev1.wax';
  let node1 = 'node1';
  let dappContract = 'dapp.wax';
  let govAccount = 'orng.wax';
  let orngOracle2 = 'oracle2.wax';
  let orngOracle3 = 'oracle3.wax';
  let orngOracle4 = 'oracle4.wax';
  let treasuryAccount = 'treasury.wax';
  let requestRandContract = 'requestrand';

  [
    orngOracle,
    orngOracle2,
    orngOracle3,
    orngOracle4,
    orngV1Oracle,
    dappContract,
    node1,
  ] = await chain.system.createAccounts(
    [
      orngOracle,
      orngOracle2,
      orngOracle3,
      orngOracle4,
      orngV1Oracle,
      dappContract,
      node1,
    ],
    '200000.00000000 WAX'
  );

  orngContract = await chain.system.createAccount(
    orngContract,
    '10000.00000000 WAX',
    2000000
  );
  govAccount = orngContract;

  treasuryAccount = await chain.system.createAccount(
    treasuryAccount,
    '10000.00000000 WAX',
    2000000
  );

  requestRandContract = await chain.system.createAccount(
    requestRandContract,
    '10000.00000000 WAX',
    2000000
  );

  await orngContract.setContract({
    abi: './test/artifacts/wax.orng.abi',
    wasm: './test/artifacts/wax.orng.wasm',
  });
  await orngContract.addCode('active');

  await requestRandContract.setContract({
    abi: './benchmark/contract/build/requestrand.abi',
    wasm: './benchmark/contract/build/requestrand.wasm',
  });
  await requestRandContract.addCode('active');

  await orngContract.contract.action.setpubkey(
    {
      version: 1,
      exponent: PUBKEY.e,
      modulus: PUBKEY.n,
    },
    [
      {
        actor: govAccount.name,
        permission: 'active',
      },
    ]
  );

  await orngContract.contract.action.configv2(
    {
      fee_per_call: '0.00500000 WAX',
      strike_max: 3,
    },
    [
      {
        actor: orngContract.name,
        permission: 'active',
      },
    ]
  );

  // Adaptive rate-limiting config is required by the v3.x contract before
  // requests can be served. Values mirror wax-orng's own test suite.
  await orngContract.contract.action.configadptive(
    {
      total_capacity_calls_per_hr: 20000,
      free_min_calls_per_hr: 1000,
      headroom_calls_per_hr: 2000,
      per_dapp_min_calls_per_hr: 15,
      burst_window_hours: 150,
      ema_half_life_sec: 1200,
      ema_min_update_sec: 15,
    },
    [
      {
        actor: orngContract.name,
        permission: 'active',
      },
    ]
  );

  await orngContract.contract.action.setoracles(
    {
      oracles: [orngOracle.name, orngOracle2.name],
    },
    [
      {
        actor: govAccount.name,
        permission: 'active',
      },
    ]
  );

  // The v3 contract delivers via the randnotify notification by default, which
  // never throws (so a failing dapp can't surface as an undelivered job). Enable
  // allowlist enforcement and register the requestrand test contract as a legacy
  // callback dapp so its reverting receiverand drives the markfailed ->
  // undelivered1 path. dapp.wax is a bare account (not in the allowlist), so it
  // stays on the notification path and its deliveries still succeed.
  await orngContract.contract.action.setconfig(
    {
      config: 'allowlist',
      value: 1,
    },
    [
      {
        actor: orngContract.name,
        permission: 'active',
      },
    ]
  );

  await orngContract.contract.action.addlegacy(
    {
      dapp: requestRandContract.name,
    },
    [
      {
        actor: orngContract.name,
        permission: 'active',
      },
    ]
  );

  await treasuryAccount.transfer(
    orngContract.name,
    '1000.00000000 WAX',
    'treasury'
  );
  await dappContract.transfer(
    orngContract.name,
    '100.00000000 WAX',
    'deposit-' + dappContract.name
  );
  await requestRandContract.transfer(
    orngContract.name,
    '100.00000000 WAX',
    'deposit-' + requestRandContract.name
  );

  return {
    orngContract,
    orngOracle,
    orngV1Oracle,
    node1,
    dappContract,
    govAccount,
    treasuryAccount,
    orngOracle2,
    orngOracle3,
    orngOracle4,
    requestRandContract,
  };
}

module.exports = {
  createJobs,
  setupOrngContract,
  sha256,
};
