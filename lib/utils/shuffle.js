/**
 * Seeded random number generator using a simple Linear Congruential Generator (LCG)
 * This provides deterministic pseudo-random numbers based on a seed
 */
class SeededRandom {
  constructor(seed) {
    this.seed = seed % 2147483647;
    if (this.seed <= 0) this.seed += 2147483646;
  }

  /**
   * Returns a pseudo-random number between 0 and 1
   */
  next() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }
}

/**
 * Fisher-Yates shuffle algorithm with optional seeded randomization
 * @param {Array} array - Array to shuffle (will not be modified)
 * @param {number} seed - Optional seed for deterministic randomization
 * @returns {Array} - New shuffled array
 */
function shuffleArray(array, seed) {
  if (!Array.isArray(array)) {
    throw new TypeError('First argument must be an array');
  }

  if (array.length <= 1) {
    return [...array];
  }

  // Create a copy to avoid mutating the original array
  const shuffled = [...array];

  // Use seeded random if seed is provided, otherwise use Math.random
  const random = seed !== undefined ? new SeededRandom(seed) : null;
  const getRandom = random ? () => random.next() : () => Math.random();

  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(getRandom() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

/**
 * Generate a deterministic seed based on oracle key index, process modulus, and current day
 * This ensures each oracle (and each cluster worker) has a different pattern,
 * but the pattern is consistent within a day
 * @param {number} keyIndex - The oracle's key index (1-based)
 * @param {number} processModulus - Optional process modulus for cluster mode (0-based)
 * @returns {number} - Generated seed
 */
function generateDailySeed(keyIndex, processModulus) {
  if (!Number.isInteger(keyIndex) || keyIndex < 1) {
    throw new TypeError('keyIndex must be a positive integer');
  }

  // Get current day timestamp (milliseconds since epoch divided by milliseconds per day)
  const daysSinceEpoch = Math.floor(Date.now() / 86400000);

  // Combine keyIndex, processModulus (if provided), and day to create unique seed
  // In cluster mode: each worker process gets different seed
  // Format: keyIndex * 1M + processModulus * 10K + day
  const modulus = Number.isInteger(processModulus) && processModulus >= 0 ? processModulus : 0;
  return keyIndex * 1000000 + modulus * 10000 + daysSinceEpoch;
}

module.exports = {
  shuffleArray,
  generateDailySeed,
  SeededRandom, // Export for testing
};
