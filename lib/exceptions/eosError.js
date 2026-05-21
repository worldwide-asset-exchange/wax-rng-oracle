class EosError extends Error {
  constructor (...args) {
    super(...args)
    this.name = 'EosError'
  }
}

module.exports = { EosError }
