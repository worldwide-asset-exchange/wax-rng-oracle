let config = require('./config/configLoader').loadConfig();

const {
  ThresholdRSAShare,
  ThresholdRSAVerifier,
} = require('@waxio/rsa-threshold-signatures');
const logger = require('./config/logger');
const Int64 = require('int64-buffer');
const eosjsAccountName = require('eosjs-account-name');
const crypto = require('crypto');

const forge = require('node-forge');
const BigInteger = forge.jsbn.BigInteger;
/**
 * ShareKeyService - Service for threshold RSA signature generation
 * Constructs a ThresholdRSAShare instance and provides message signing functionality
 */
class ShareKeyService {
  constructor(config = {}) {
    this.config = config;

    this.thresholdRSAShare = null;
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

      // Create ThresholdRSAShare instance
      this.thresholdRSAShare = new ThresholdRSAShare({
        bits: this.bits,
        publicKey: this.publicKey,
        sharedKey: this.sharedKey,
        verificationKey: this.verificationKey,
        verificationKeyShare: this.verificationKeyShare,
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

    // Validate signature share is within bounds
    if (
      this.publicKey &&
      signResult.signatureShare.compareTo(this.publicKey.n) >= 0
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
    const msgHash = forge.md.sha256
      .create()
      .update(message)
      .digest()
      .toHex();
    const msgBigInt = new BigInteger(msgHash, 16);
    return msgBigInt;
  }

  parseBigInteger(value) {
    if (typeof value === 'string') {
      return new BigInteger(value, 16);
    }
    return value;
  }

  combinePartialSignatures(parts, msgBigInt) {
    logger.info(`Combining ${parts.length} partial signatures`);
    let rsaSigShares = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const rsaSigShare = {
        shareIndex: part.idx,
        signatureShare: this.parseBigInteger(part.sig_i),
      };
      rsaSigShares.push(rsaSigShare);
    }
    const threshold = config.get('shareKey.threshold');
    const numParties = config.get('shareKey.numParties');
    const publicKey = config.get('shareKey.publicKey');
    const verificationKey = config.get('shareKey.verificationKey');
    const bits = config.get('shareKey.bits');
    const vku = config.get('shareKey.vku');
    const thresholdRSAVerifier = new ThresholdRSAVerifier({
      threshold,
      numParties,
      bits,
      publicKey,
      verificationKey,
      vku,
    });
    const combinedSig = thresholdRSAVerifier.verifySignatureMessage(
      msgBigInt,
      rsaSigShares
    );
    return combinedSig;
  }
}

module.exports = ShareKeyService;
