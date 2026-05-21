class InvalidParameterError extends Error {
  constructor (...args) {
    super(...args);
    this.name = 'InvalidParameterError'
  }
}

module.exports = { InvalidParameterError };
