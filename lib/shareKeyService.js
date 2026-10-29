const {
  ThresholdRSAShare,
  ThresholdRSAVerifier,
  CombineError,
  verifyShareConsistency,
  parseBigInteger,
} = require('@waxio/rsa-threshold-signatures');
const logger = require('./config/logger');
const eosjsAccountName = require('eosjs-account-name');
const crypto = require('crypto');

// A partial signature as the contract stores it in reqs.parts[].sig_i: the
// unpadded lower-case hex the member produced with signatureShare.toString(16).
// Anything else never came from an honest member and is kept away from the
// library entirely (the library itself then rejects range / gcd failures).
const PARTIAL_HEX_RE = /^[0-9a-fA-F]+$/;

function isCombineError(err) {
  return err instanceof CombineError || (!!err && err.name === 'CombineError');
}

/**
 * ShareKeyService - Service for threshold RSA signature generation
 * Constructs a ThresholdRSAShare instance and provides message signing functionality
 */
class ShareKeyService {
  constructor(config = {}) {
    this.config = config;

    this.thresholdRSAShare = null;
    this.thresholdRSAVerifier = null;
    this.initialized = false;

    logger.info(
      'ShareKeyService initialized with config:' + this.config.shareIndex
    );
  }

  /**
   * Initialize the ThresholdRSAShare instance
   * @param {Object} shareConfig - Configuration for the threshold RSA share
   * @param {Object} shareConfig.publicKey - The public key object
   * @param {Object} shareConfig.sharedKey - The shared key for this oracle
   * @param {Object} shareConfig.verificationKey - The verification key
   * @param {number} shareConfig.shareIndex - Index of this share (1-based)
   * @param {Object} shareConfig.verificationKeyShare - Verification key share for this oracle
   */
  async initialize() {
    try {
      if (!this.config) {
        throw new Error('Share configuration is required for initialization');
      }

      // Validate required configuration
      let newConfig = this.validateShareConfig(this.config);
      this.config = newConfig;

      this.threshold = this.config.threshold || 2;
      this.numParties = this.config.numParties || 3;
      this.bits = this.config.bits || 4096;
      // Update configuration with provided values
      this.publicKey = this.config.publicKey;
      this.sharedKey = this.config.sharedKey;
      this.verificationKey = this.config.verificationKey;
      this.shareIndex = this.config.shareIndex;
      this.verificationKeyShare = this.config.verificationKeyShare;
      this.vku = this.config.vku;

      // Create ThresholdRSAShare instance (strict parsing + range checks happen here)
      this.thresholdRSAShare = new ThresholdRSAShare(this.shareConfig());
      this.modulus = parseBigInteger(this.publicKey.n, 'publicKey.n');

      // One verifier for the life of the process, built from the same key set
      // this member signs with (previously rebuilt from global config per combine).
      this.thresholdRSAVerifier = new ThresholdRSAVerifier({
        threshold: this.threshold,
        numParties: this.numParties,
        bits: this.bits,
        publicKey: this.publicKey,
        verificationKey: this.verificationKey,
        vku: this.vku,
      });

      this.initialized = true;
      logger.info('ThresholdRSAShare initialized successfully', {
        shareIndex: this.shareIndex,
        threshold: this.threshold,
        numParties: this.numParties,
      });
    } catch (error) {
      logger.error('Failed to initialize ThresholdRSAShare:', error);
      throw error;
    }
  }

  /**
   * The share configuration in the library's ThresholdRSAShareConfig shape.
   * @private
   */
  shareConfig() {
    return {
      bits: this.bits,
      publicKey: this.publicKey,
      sharedKey: this.sharedKey,
      verificationKey: this.verificationKey,
      verificationKeyShare: this.verificationKeyShare,
      vku: this.vku,
    };
  }

  /**
   * Boot-time self-check of this member's share against an independently
   * sourced public key (the on-chain `pubkeys` row for the active version).
   * Never throws on a failed check: returns the library's structured result so
   * the caller can log check NAMES only (the failure strings carry bit lengths
   * and the public exponent, never the share).
   * @param {{expectedPublicKey?: {n: string, e: string}}} options
   * @returns {import('@waxio/rsa-threshold-signatures').ShareConsistencyResult}
   */
  verifyConsistency(options = {}) {
    if (!this.initialized) {
      throw new Error(
        'ShareKeyService not initialized. Call initialize() first.'
      );
    }
    return verifyShareConsistency(this.shareConfig(), {
      shareIndex: this.shareIndex,
      numParties: this.numParties,
      threshold: this.threshold,
      expectedPublicKey: options.expectedPublicKey,
      throwOnFailure: false,
    });
  }

  /**
   * Sign a message using the threshold RSA share
   * @param {string} message - The message to sign
   * @returns {Object} - Object containing signatureShare, proof, and msgBigInt
   */
  async sign(message) {
    try {
      if (!this.initialized || !this.thresholdRSAShare) {
        throw new Error(
          'ShareKeyService not initialized. Call initialize() first.'
        );
      }

      if (!message) {
        throw new Error('Message is required for signing');
      }

      logger.debug('Signing message with ThresholdRSAShare', {
        messageLength: message.length,
        shareIndex: this.shareIndex,
      });

      // Sign the message using ThresholdRSAShare
      const signResult = this.thresholdRSAShare.signMessage(message);

      // Validate the signature result
      this.validateSignatureResult(signResult);

      logger.info(
        'Message signed successfully' +
          JSON.stringify({
            shareIndex: this.shareIndex,
            signatureShareLength: signResult.signatureShare
              ? signResult.signatureShare.toString().length
              : 0,
            proofExists: !!signResult.proof,
            msgBigIntBitLength: signResult.msgBigInt
              ? signResult.msgBigInt.bitLength()
              : 0,
            message: message.toString('hex'),
          })
      );

      return {
        signatureShare: signResult.signatureShare,
        proof: signResult.proof,
        msgBigInt: signResult.msgBigInt,
        shareIndex: this.shareIndex,
        sharedVerificationKey: this.verificationKeyShare,
      };
    } catch (error) {
      logger.error('Failed to sign message:', error);
      throw error;
    }
  }

  /**
   * Create a signature share object compatible with ThresholdRSAVerifier
   * @param {string} message - The message that was signed
   * @returns {Object} - Signature share object for verification
   */
  async createSignatureShare(message) {
    try {
      const signResult = await this.sign(message);

      return {
        signatureShare: signResult.signatureShare,
        proof: signResult.proof,
        sharedVerificationKey: signResult.sharedVerificationKey,
        shareIndex: signResult.shareIndex,
      };
    } catch (error) {
      logger.error('Failed to create signature share:', error);
      throw error;
    }
  }

  /**
   * Validate share configuration
   * @private
   */
  validateShareConfig(config) {
    const required = [
      'publicKey',
      'sharedKey',
      'verificationKey',
      'shareIndex',
      'verificationKeyShare',
      'vku',
    ];

    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    let newConfig = { ...config };

    newConfig.shareIndex = parseInt(config.shareIndex, 10);
    newConfig.threshold = parseInt(config.threshold, 10) || 0;
    newConfig.numParties = parseInt(config.numParties, 10) || 0;
    newConfig.bits = parseInt(config.bits, 10) || 4096;

    if (typeof newConfig.shareIndex !== 'number' || newConfig.shareIndex < 1) {
      throw new Error('shareIndex must be a positive number (1-based)');
    }

    if (newConfig.shareIndex > newConfig.numParties) {
      throw new Error(
        `shareIndex (${newConfig.shareIndex}) cannot exceed numParties (${newConfig.numParties})`
      );
    }
    return newConfig;
  }

  /**
   * Validate signature result
   * @private
   */
  validateSignatureResult(signResult) {
    if (!signResult) {
      throw new Error('Sign operation returned null result');
    }

    if (!signResult.signatureShare) {
      throw new Error('Sign operation did not return a signature share');
    }

    if (!signResult.msgBigInt) {
      throw new Error('Sign operation did not return msgBigInt');
    }

    // Validate signature share is within bounds (compare integers, not the hex string)
    if (
      this.modulus &&
      signResult.signatureShare.compareTo(this.modulus) >= 0
    ) {
      throw new Error('Signature share is not less than modulus');
    }

    // Validate message hash bit length (should be 256 bits for SHA-256)
    if (signResult.msgBigInt.bitLength() > 256) {
      throw new Error('Message hash bit length exceeds 256 bits');
    }

    // Validate proof hash bit length (should be 256 bits for SHA-256)
    if (
      signResult.proof &&
      signResult.proof.c &&
      signResult.proof.c.bitLength() > 256
    ) {
      throw new Error('Proof challenge bit length exceeds 256 bits');
    }
  }

  /**
   * Get service status and configuration
   * @returns {Object} - Service status information
   */
  getStatus() {
    return {
      initialized: this.initialized,
      threshold: this.threshold,
      numParties: this.numParties,
      bits: this.bits,
      shareIndex: this.shareIndex,
      hasPublicKey: !!this.publicKey,
      hasSharedKey: !!this.sharedKey,
      hasVerificationKey: !!this.verificationKey,
      hasVerificationKeyShare: !!this.verificationKeyShare,
    };
  }

  /**
   * Check if the service is ready for signing
   * @returns {boolean} - True if ready for signing
   */
  isReady() {
    return (
      this.initialized &&
      !!this.thresholdRSAShare &&
      !!this.publicKey &&
      !!this.sharedKey &&
      !!this.verificationKey &&
      !!this.verificationKeyShare &&
      typeof this.shareIndex === 'number'
    );
  }

  make_msg(seedHex, dappName, nonce) {
    const seedBuf = Buffer.from(seedHex, 'hex');
    const nameValue = eosjsAccountName.nameToUint64(dappName);

    const nameBuf = Buffer.alloc(8);
    nameBuf.writeBigUInt64LE(BigInt(nameValue));
    const nBuf = Buffer.alloc(8);
    nBuf.writeBigUInt64LE(BigInt(nonce));
    const finalBuf = Buffer.concat([seedBuf, nameBuf, nBuf]);
    const hash = crypto
      .createHash('sha256')
      .update(finalBuf)
      .digest('hex');
    return hash;
  }

  hash_msg(message) {
    const msgHash = crypto
      .createHash('sha256')
      .update(message)
      .digest('hex');
    return parseBigInteger(msgHash, 'message hash');
  }

  /**
   * Split the on-chain reqs.parts[] rows into the well-formed partials that go
   * to the library and the malformed ones that never do.
   * @private
   */
  screenPartials(parts) {
    const accepted = [];
    const rejectedShares = [];
    parts.forEach((part, position) => {
      const idx = part && part.idx;
      const sigI = part && part.sig_i;
      let reason;
      if (!Number.isInteger(idx)) {
        reason = 'part index is not an integer';
      } else if (typeof sigI !== 'string' || !PARTIAL_HEX_RE.test(sigI)) {
        reason = 'partial signature is not a hex string';
      }
      if (reason) {
        rejectedShares.push({ position, shareIndex: idx, reason });
      } else {
        accepted.push({ position, shareIndex: idx, signatureShare: sigI });
      }
    });
    return { accepted, rejectedShares };
  }

  /**
   * Combine the on-chain partial signatures into the full RSA signature.
   *
   * Returns the library's CombineResult (signature = lower-case hex, exactly
   * bits/4 wide, < n — the exact string handed to setrand) plus the diagnostics
   * a member needs to attribute a bad partial: `rejectedShares` (malformed /
   * out-of-range partials, by position in `parts` and share index — never the
   * value), `failedSubsets`, `suspectShareIndices`, `usedShareIndices`.
   *
   * Throws the library's CombineError (`code` INVALID_SHARE when fewer than
   * `threshold` well-formed partials remain, NO_VALID_SUBSET when no k-subset
   * verifies, DUPLICATE_INDEX, NOT_ENOUGH_SHARES). Callers must treat that as
   * a per-job failure, not a crash.
   *
   * @param {{idx: number, sig_i: string}[]} parts  rows of reqs.parts as read from chain
   * @param {Buffer} message  the raw 32 message bytes (make_msg output decoded from hex)
   */
  combinePartialSignatures(parts, message) {
    if (!this.initialized || !this.thresholdRSAVerifier) {
      throw new Error(
        'ShareKeyService not initialized. Call initialize() first.'
      );
    }
    const safeParts = Array.isArray(parts) ? parts : [];
    logger.info(`Combining ${safeParts.length} partial signatures`);

    const { accepted, rejectedShares } = this.screenPartials(safeParts);
    const describe = () =>
      rejectedShares
        .map(
          r => `index ${r.shareIndex} at position ${r.position} (${r.reason})`
        )
        .join(', ');

    if (accepted.length < this.threshold) {
      throw new CombineError(
        'INVALID_SHARE',
        `Signature share(s) rejected before combine: ${describe()}; only ${
          accepted.length
        } well-formed share(s) remain for threshold ${this.threshold}`,
        rejectedShares
      );
    }

    try {
      const result = this.thresholdRSAVerifier.combineSignatureMessage(
        message,
        accepted.map(({ shareIndex, signatureShare }) => ({
          shareIndex,
          signatureShare,
        }))
      );
      return {
        ...result,
        // the library numbers positions within the array it was given; report
        // positions within the on-chain parts array instead
        rejectedShares: rejectedShares.concat(
          result.rejectedShares.map(r => ({
            ...r,
            position: accepted[r.position].position,
          }))
        ),
      };
    } catch (err) {
      if (isCombineError(err) && rejectedShares.length) {
        err.rejectedShares = rejectedShares.concat(
          (err.rejectedShares || []).map(r => ({
            ...r,
            position: accepted[r.position].position,
          }))
        );
      }
      throw err;
    }
  }
}

ShareKeyService.isCombineError = isCombineError;

module.exports = ShareKeyService;
