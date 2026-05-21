const { Api, JsonRpc } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { TextDecoder, TextEncoder } = require('util');
const fetch = require('node-fetch');

function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

const signatureProvider = new JsSignatureProvider([
  '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3',
]);
const eosRpc = new JsonRpc('http://127.0.0.1:8888', { fetch });
const eos = new Api({
  rpc: eosRpc,
  signatureProvider,
  textEncoder: new TextEncoder(),
  textDecoder: new TextDecoder(),
});

const numberRequests = 1000;
const concurrencyRequests = 20;
const delay = 100;
const benmarkFailJob = false;

async function start() {
  const startTime = new Date().getTime();
  let actionName = 'requestsucce';
  if (benmarkFailJob) {
    actionName = 'requestfail';
  }
  const publicKeyConfigTable = await eosRpc.get_table_rows({
    json: true,
    code: 'orng.wax',
    scope: 'orng.wax',
    table: 'pubconfig.a',
    limit: 1,
  });
  const { active_key_index } = publicKeyConfigTable.rows[0];

  const signvalTable = await eosRpc.get_table_rows({
    json: true,
    code: 'orng.wax',
    scope: active_key_index,
    table: 'signvals.a',
    reverse: true,
  });
  const lastJobId = signvalTable.rows[0]
    ? signvalTable.rows[0].signing_value
    : 0;
  let actions = [];
  for (let i = lastJobId + 1; i <= lastJobId + numberRequests; i++) {
    actions.push({
      account: 'requestrand',
      name: actionName,
      authorization: [
        {
          actor: 'requestrand',
          permission: 'active',
        },
      ],
      data: {
        signing_value: i,
      },
    });

    if (actions.length > concurrencyRequests) {
      await eos.transact(
        {
          actions,
        },
        {
          blocksBehind: 3,
          expireSeconds: 300 + Math.floor(Math.random() * 3300), // avoid duplicate transaction
        }
      );
      actions = [];
      console.log('Processed ', i, ' requests');
      await sleep(delay);
    }
  }

  if (actions.length > 0) {
    await eos.transact(
      {
        actions,
      },
      {
        blocksBehind: 3,
        expireSeconds: 300 + Math.floor(Math.random() * 3300), // avoid duplicate transaction
      }
    );
  }

  let pollingTime = 0;
  while (true) {
    const jobsTable = await eosRpc.get_table_rows({
      json: true,
      code: 'orng.wax',
      scope: 'orng.wax',
      table: 'jobs.b',
      limit: 1000,
    });
    await sleep(200);
    if (jobsTable.rows.length === 0) {
      const endTime = new Date().getTime();
      console.log('All job processed');
      console.log(
        'Total time for process ',
        numberRequests,
        ' jobs ',
        endTime - startTime
      );
      break;
    }
    if (pollingTime % 10 === 0) {
      console.log('Polling to check time nodes needed to process jobs');
    }
    pollingTime++;
  }

  console.log('DONE');
}

start();
