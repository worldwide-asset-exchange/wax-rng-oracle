const { Api, JsonRpc, RpcError } = require('eosjs');
const fetchRetry = require('./fetchRetry').default;
let config = require('./configLoader').loadConfig();
const { TextDecoder, TextEncoder } = require('util'); // node only
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { EosError } = require('../exceptions/eosError');
let orngContract;

const eosApiConfig = {
  'orng': config.eos.orng,
  'oracle': config.eos.oracle,
  'endpoint': config.eos.apiUrl,
  'chainId': config.eos.chainId
};

const fetch = fetchRetry(config.fetchRetry.maxRetries);

const fetchWithHeaders = (url , options = {}) => {
  const headers = {
    ...{
      'X-WAX-Source': 'orng-oracle',
    },
    ...options.headers,
  };
  return fetch(url, { ...options, headers });
};

const eosRpc = new JsonRpc(eosApiConfig.endpoint, { fetch: fetchWithHeaders });

class OrngContract {
  constructor(rpc, signatureProvider) {
    this.config = { ...config.get('eos.orng')};
    this.rpc = rpc;
    this.eos = new Api({ rpc, signatureProvider, textEncoder: new TextEncoder(), textDecoder: new TextDecoder() })
  }

  // Oracle actions for v2 contract
  submitpart(oracle, id, ver, sig_i) {
    return this.pushAction(
      this.config.contractName,
      'submitpart',
      oracle,
      this.config.auth,
      { oracle, id, ver, sig_i },
      this.config.maxCpu
    )
  }

  setrand(oracle, id, ver, sig) {
    return this.pushAction(
      this.config.contractName,
      'setrand',
      oracle,
      this.config.auth,
      { oracle, id, ver, sig },
      this.config.maxCpu
    )
  }

  markfailed(oracle, id, ver, sig, error_message) {
    return this.pushAction(
      this.config.contractName,
      'markfailed',
      oracle,
      this.config.auth,
      { oracle, id, ver, sig, error_message },
      this.config.maxCpu
    )
  }

  retrydeliver(oracle, request_id) {
    return this.pushAction(
      this.config.contractName,
      'retrydeliver',
      oracle,
      this.config.auth,
      { oracle, request_id },
      this.config.maxCpu
    )
  }
 //verifysig2(eosio::checksum256 sig_val, const string& signature, const std::string& exponent, const std::string& modulus)
  verifysig2(sig_val, signature, exponent, modulus) {
    return this.pushAction(
      this.config.contractName,
      'verifysig2',
      this.config.nodeOwner,
      this.config.auth,
      { sig_val, signature, exponent, modulus }, 
      this.config.maxCpu
    )
  }

  // DApp actions
  requestrand(assoc_id, signing_value, caller) {
    return this.pushAction(
      this.config.contractName,
      'requestrand',
      caller,
      'active',
      { assoc_id, signing_value, caller },
      this.config.maxCpu
    )
  }

  // Updated dapperror with new parameter order
  dapperror(dapp, job_id, message) {
    return this.pushAction(
      this.config.contractName,
      'dapperror',
      dapp,
      'active@ornglog',
      { dapp, job_id, message }
    )
  }

  // Staking and rewards
  unstake(dapp, quantity) {
    return this.pushAction(
      this.config.contractName,
      'unstake',
      dapp,
      'active',
      { dapp, quantity },
      this.config.maxCpu
    )
  }

  claim(oracle) {
    return this.pushAction(
      this.config.contractName,
      'claim',
      oracle,
      'active',
      { oracle },
      this.config.maxCpu
    )
  }

  // Governance actions
  setpubkey(version, exponent, modulus) {
    return this.pushAction(
      this.config.contractName,
      'setpubkey',
      this.config.nodeOwner,
      this.config.auth,
      { version, exponent, modulus },
      this.config.maxCpu
    )
  }

  setoracles(oracles) {
    return this.pushAction(
      this.config.contractName,
      'setoracles',
      this.config.nodeOwner,
      this.config.auth,
      { oracles },
      this.config.maxCpu
    )
  }

  resetsuspen(oracle) {
    return this.pushAction(
      this.config.contractName,
      'resetsuspen',
      this.config.nodeOwner,
      this.config.auth,
      { oracle },
      this.config.maxCpu
    )
  }

  configv2(fee_per_call, strike_max, k_calls_per_wax, treas_hardfloor) {
    return this.pushAction(
      this.config.contractName,
      'configv2',
      this.config.nodeOwner,
      this.config.auth,
      { fee_per_call, strike_max, k_calls_per_wax, treas_hardfloor },
      this.config.maxCpu
    )
  }

  cleanup(oracle, batch_size) {
    return this.pushAction(
      this.config.contractName,
      'cleanup',
      oracle,
      this.config.auth,
      {oracle, batch_size},
      this.config.maxCpu
    )
  }

  // Admin actions
  killjobs(job_ids) {
    return this.pushAction(
      this.config.contractName,
      'killjobs',
      'oracle.wax',
      'active',
      { job_ids },
      this.config.maxCpu
    )
  }

  pause(paused) {
    return this.pushAction(
      this.config.contractName,
      'pause',
      this.config.nodeOwner,
      this.config.auth,
      { paused },
      this.config.maxCpu
    )
  }

  pauserequest(paused) {
    return this.pushAction(
      this.config.contractName,
      'pauserequest',
      this.config.nodeOwner,
      this.config.auth,
      { paused },
      this.config.maxCpu
    )
  }

  setconfig(config, value) {
    return this.pushAction(
      this.config.contractName,
      'setconfig',
      this.config.nodeOwner,
      this.config.auth,
      { config, value },
      this.config.maxCpu
    )
  }

  seterrorsize(dapp, queue_size) {
    return this.pushAction(
      this.config.contractName,
      'seterrorsize',
      dapp,
      'active',
      { dapp, queue_size },
      this.config.maxCpu
    )
  }

  setbwpayer(payee, payer) {
    return this.pushAction(
      this.config.contractName,
      'setbwpayer',
      payee,
      'active',
      { payee, payer },
      this.config.maxCpu
    )
  }

  acceptbwpay(payee, payer, accepted) {
    return this.pushAction(
      this.config.contractName,
      'acceptbwpay',
      payer,
      'active',
      { payee, payer, accepted },
      this.config.maxCpu
    )
  }

  setmaxjobs(dapp, max_jobs) {
    return this.pushAction(
      this.config.contractName,
      'setmaxjobs',
      this.config.nodeOwner,
      this.config.auth,
      { dapp, max_jobs },
      this.config.maxCpu
    )
  }

  ban(dapp) {
    return this.pushAction(
      this.config.contractName,
      'ban',
      this.config.nodeOwner,
      this.config.auth,
      { dapp },
      this.config.maxCpu
    )
  }

  unban(dapp) {
    return this.pushAction(
      this.config.contractName,
      'unban',
      this.config.nodeOwner,
      this.config.auth,
      { dapp },
      this.config.maxCpu
    )
  }

  // Legacy v1 support
  cleansigvals(scope, rows_num) {
    return this.pushAction(
      this.config.contractName,
      'cleansigvals',
      'oracle.wax',
      'active',
      { scope, rows_num },
      this.config.maxCpu
    )
  }

  v1rrcompat(signing_value) {
    return this.pushAction(
      this.config.contractName,
      'v1rrcompat',
      'oraclev1.wax',
      'active',
      { signing_value },
      this.config.maxCpu
    )
  }

  version() {
    return this.pushAction(
      this.config.contractName,
      'version',
      this.config.nodeOwner,
      this.config.auth,
      {},
      this.config.maxCpu
    )
  }

  pushAction(account, action, actor, permission, data, maxCpu) {
    maxCpu = maxCpu || 0;
    return this.eos.transact({
      max_cpu_usage_ms: maxCpu,
      actions: [{
        account: account,
        name: action,
        authorization: [{
          actor,
          permission,
        }],
        data: data,
      }]
    }, {
      blocksBehind: 3,
      expireSeconds: 120 + Math.floor(Math.random() * 100) // avoid duplicate transaction
    });
  }

  pushActions(actions, maxCpu) {
    maxCpu = maxCpu || 0;
    return this.eos.transact({
      max_cpu_usage_ms: maxCpu,
      actions
    }, {
      blocksBehind: 3,
      expireSeconds: 30
    });
  }
}

const getOrngContract = function () {
  if (!orngContract) {
    try {
      const signatureProvider = new JsSignatureProvider([config.get('eos.orng.privateKey')]);
      orngContract = new OrngContract(eosRpc, signatureProvider);
    } catch (e) {
      throw new EosError(e);
    }
  }
  return orngContract;
};


module.exports = {
  eosRpc,
  getOrngContract,
  RpcError
}
