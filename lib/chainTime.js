/**
 * nodeos prints block times without a zone suffix ("2026-11-16T20:00:00.500")
 * and means UTC; Date.parse would read that as local time. One parser for
 * every place that compares a chain time with the host clock.
 */
const HEAD_LAG_WARN_SECONDS = 30;

const HAS_ZONE = /(?:[Zz]|[+-]\d\d:?\d\d)$/;

/** @returns {number} epoch ms, NaN when unparseable */
function parseChainTime(text) {
  const t = text === undefined || text === null ? '' : String(text).trim();
  return Date.parse(HAS_ZONE.test(t) ? t : `${t}Z`);
}

/**
 * Seconds between `now` and the node's head block, or null when get_info did
 * not return a parseable head_block_time. Never negative.
 */
function headBlockLagSeconds(info, now = Date.now()) {
  if (!info || typeof info.head_block_time !== 'string') return null;
  const ms = parseChainTime(info.head_block_time);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((now - ms) / 1000));
}

module.exports = { parseChainTime, headBlockLagSeconds, HEAD_LAG_WARN_SECONDS };
