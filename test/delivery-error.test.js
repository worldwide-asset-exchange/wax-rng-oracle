// WBP-2083: a rejected setrand is either the dApp refusing the result (push
// markfailed) or the API node refusing the transaction (retry). The messages
// below are the ones the 2026-11-13 → 11-16 soak stored in undelivered1 —
// 184 markfailed rows, none of them a delivery failure.
const { expect } = require('chai');
const { RpcError } = require('../lib/config/eos');
const {
  classifyPushError,
  rpcErrorMessage,
  KIND,
} = require('../lib/deliveryError');

function rpcError(code, name, message, extra = {}) {
  return new RpcError({
    code: 500,
    message: 'Internal Service Error',
    error: {
      code,
      name,
      what: extra.what || name,
      details: message
        ? [{ message, file: 'x.cpp', line_number: 1, method: 'm' }]
        : [],
    },
  });
}

describe('classifyPushError (setrand rejection → markfailed or retry)', () => {
  it('subjective failure limit (tx_cpu_usage_exceeded) is a node rejection', () => {
    const r = classifyPushError(
      rpcError(
        3080004,
        'tx_cpu_usage_exceeded',
        'transaction ' +
          'ab'.repeat(32) +
          ' exceeded failure limit for account waxswedenorg until 2026-11-16T12:00:00.500'
      )
    );
    expect(r.kind).to.equal(KIND.NODE);
    expect(r.name).to.equal('tx_cpu_usage_exceeded');
    expect(r.message).to.match(/exceeded failure limit/);
  });

  it('actor whitelist is a node rejection', () => {
    const r = classifyPushError(
      rpcError(
        3130001,
        'actor_whitelist_exception',
        'authorizing actor(s) in transaction are not on the actor whitelist: ["orng.wax"]'
      )
    );
    expect(r.kind).to.equal(KIND.NODE);
  });

  for (const [code, name, msg] of [
    [
      3080002,
      'tx_net_usage_exceeded',
      'transaction net usage is too high: 1136 > 1000',
    ],
    [3080006, 'deadline_exception', 'deadline exceeded'],
    [3040005, 'expired_tx_exception', 'expired transaction'],
    [3040008, 'tx_duplicate', 'duplicate transaction'],
    [3090003, 'unsatisfied_authorization', 'transaction declares authority'],
    [3100000, 'misc_exception', 'something odd'],
  ]) {
    it(`${name} is a node rejection`, () => {
      expect(classifyPushError(rpcError(code, name, msg)).kind).to.equal(
        KIND.NODE
      );
    });
  }

  it('an eosio_assert raised while delivering is a contract (delivery) failure', () => {
    const r = classifyPushError(
      rpcError(
        3050003,
        'eosio_assert_message_exception',
        'assertion failure with message: dapp refuses this result'
      )
    );
    expect(r.kind).to.equal(KIND.CONTRACT);
    expect(r.message).to.equal(
      'assertion failure with message: dapp refuses this result'
    );
  });

  for (const [code, name, msg] of [
    [
      3080001,
      'ram_usage_exceeded',
      'account dapp.wax has insufficient ram; needs 1000 bytes has 10 bytes',
    ],
    [3090004, 'missing_auth_exception', 'missing authority of dapp.wax'],
    [
      3050004,
      'eosio_assert_code_exception',
      'assertion failure with error code: 7',
    ],
    [
      3050005,
      'action_not_found_exception',
      'dapp.wax does not have action receiverand',
    ],
    [3050008, 'abort_called', 'abort() called'],
    [
      3050010,
      'unauthorized_ram_usage_increase',
      'unprivileged contract cannot increase RAM usage of another account',
    ],
    [3070002, 'wasm_execution_error', 'access violation'],
  ]) {
    it(`${name} is a contract failure`, () => {
      expect(classifyPushError(rpcError(code, name, msg)).kind).to.equal(
        KIND.CONTRACT
      );
    });
  }

  it('an assertion text without an error code is still a contract failure', () => {
    const err = new RpcError({
      code: 500,
      message: 'Internal Service Error',
      error: {
        details: [{ message: 'assertion failure with message: nope' }],
      },
    });
    expect(classifyPushError(err).kind).to.equal(KIND.CONTRACT);
  });

  it('"no request found" is a collision whatever the code', () => {
    const r = classifyPushError(
      rpcError(
        3050003,
        'eosio_assert_message_exception',
        'assertion failure with message: no request found'
      )
    );
    expect(r.kind).to.equal(KIND.COLLISION);
  });

  it('an RPC error without an error body (proxy 502) is a node rejection, not a crash', () => {
    const err = new RpcError({ code: 502, message: 'Bad Gateway' });
    const r = classifyPushError(err);
    expect(r.kind).to.equal(KIND.NODE);
    expect(r.message).to.equal('Bad Gateway');
    expect(r.code).to.equal(null);
  });

  it('reads the send_transaction return_failure_trace shape (processed.except)', () => {
    const err = new RpcError({
      processed: {
        except: {
          code: 3050003,
          name: 'eosio_assert_message_exception',
          message: 'eosio_assert_message assertion failure',
          stack: [
            {
              context: { level: 'error' },
              format: 'assertion failure with message: ${s}',
              data: { s: 'dapp refuses this result' },
            },
          ],
        },
      },
    });
    const r = classifyPushError(err);
    expect(r.kind).to.equal(KIND.CONTRACT);
    expect(r.code).to.equal(3050003);
    expect(r.message).to.equal(
      'assertion failure with message: dapp refuses this result'
    );
  });

  it('reads result.except with a wasm fault as a contract failure, by code not by text', () => {
    const err = new RpcError({
      result: {
        except: {
          code: 3070002,
          name: 'wasm_execution_error',
          message: 'Runtime Error Processing WASM',
          stack: [{ format: 'access violation', data: {} }],
        },
      },
    });
    expect(classifyPushError(err).kind).to.equal(KIND.CONTRACT);
  });

  it('rpcErrorMessage never throws on a bodiless RPC error and is empty for non-RPC errors', () => {
    expect(
      rpcErrorMessage(new RpcError({ code: 502, message: 'Bad Gateway' }))
    ).to.equal('Bad Gateway');
    expect(
      rpcErrorMessage(
        new RpcError({
          code: 500,
          message: 'x',
          error: {
            code: 3080006,
            name: 'deadline_exception',
            what: 'deadline exceeded',
            details: [],
          },
        })
      )
    ).to.equal('deadline exceeded');
    expect(rpcErrorMessage(new Error('socket hang up'))).to.equal('');
  });

  it('a plain Error is unknown', () => {
    const r = classifyPushError(new Error('socket hang up'));
    expect(r.kind).to.equal(KIND.UNKNOWN);
    expect(r.message).to.equal('socket hang up');
  });
});
