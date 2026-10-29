// Throwaway 2-of-3 / 4096-bit threshold key set used by the test suites,
// derived at load time from config/threshold-keys-test.json (the dealer output
// that config/test.json's member-1 entry and the Makefile's local-chain
// setpubkey also come from) — one source, no second copy of the values.
// It has never signed anything on a real chain and must never be used for one.
const dealer = require('../../config/threshold-keys-test.json');

function member(shareIndex) {
  return {
    threshold: dealer.threshold,
    numParties: dealer.numParties,
    bits: dealer.bits,
    shareIndex,
    publicKey: { n: dealer.publicKey.n, e: dealer.publicKey.e },
    sharedKey: dealer.sharedKey.shares[shareIndex - 1],
    verificationKey: dealer.sharedKey.v,
    verificationKeyShare: dealer.sharedKey.verificationKeys[shareIndex - 1],
    vku: dealer.sharedKey.vku,
  };
}

const shareKey1 = member(1);
const shareKey2 = member(2);
const shareKey3 = member(3);

module.exports = { shareKey1, shareKey2, shareKey3, member };
