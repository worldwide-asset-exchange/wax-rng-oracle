function isTrue(v) {
  return (
    (typeof v === 'string' &&
      !['false', '0', 'null', 'undefined'].includes(v)) ||
    (typeof v !== 'string' && !!v)
  );
}

module.exports = { isTrue };