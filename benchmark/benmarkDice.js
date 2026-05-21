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

const numberRequests = 50;
const concurrencyRequests = 2;
const delay = 100;

async function start() {
  const startTime = new Date().getTime();
  let actionName = 'rolldie';
  let actions = [];
  for (let i = 0; i <= numberRequests; i++) {
    actions.push({
      account: 'diceexample1',
      name: actionName,
      authorization: [
        {
          actor: 'diceexample1',
          permission: 'active',
        },
      ],
      data: {
        player: 'diceexample1',
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
    const reqsTable = await eosRpc.get_table_rows({
      json: true,
      code: 'orng.wax',
      scope: 'orng.wax',
      table: 'reqs',
      limit: 1000,
    });
    await sleep(200);
    if (reqsTable.rows.length === 0) {
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
