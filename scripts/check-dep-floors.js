#!/usr/bin/env node
/**
 * Dependency floors for the custody path (ORC-1 / SIG-13, SIG-4, SIG-5).
 *
 * Today the oracle's protection against the node-forge modInverse(0) hang is a
 * hoisted node-forge 1.4.0 in the lockfile, and its protection against a
 * poisoned partial is signing-library 2.0.0. Both are one lockfile regeneration
 * away from silently regressing, so CI and the image build assert them:
 *
 *   node scripts/check-dep-floors.js [node_modules dir]
 *
 * Every installed copy of each package (hoisted or nested) must satisfy the
 * floor; a nested old copy is exactly how a regression would hide. Exit 1 with
 * one line per violation.
 */
const fs = require('fs');
const path = require('path');

const FLOORS = {
  'node-forge': '1.4.0',
  '@waxio/rsa-threshold-signatures': '2.0.0',
};

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] || null,
  };
}

// >= 0 when a >= b. A prerelease of X.Y.Z ranks below X.Y.Z itself.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (!!pa.prerelease === !!pb.prerelease) return 0;
  return pa.prerelease ? -1 : 1;
}

function readVersion(pkgDir) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')
    );
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch (e) {
    return null;
  }
}

function listPackageDirs(nodeModulesDir) {
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === '.bin' || entry.name.startsWith('.')) continue;
    const full = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(full, { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink()) {
          dirs.push({
            name: `${entry.name}/${scoped.name}`,
            dir: path.join(full, scoped.name),
          });
        }
      }
    } else {
      dirs.push({ name: entry.name, dir: full });
    }
  }
  return dirs;
}

/** Every installed copy of every package under `root` (recursing into nested node_modules). */
function findInstalledCopies(root, wanted) {
  const found = [];
  const seen = new Set();
  const walk = nodeModulesDir => {
    const real = fs.existsSync(nodeModulesDir)
      ? fs.realpathSync(nodeModulesDir)
      : nodeModulesDir;
    if (seen.has(real)) return;
    seen.add(real);
    for (const { name, dir } of listPackageDirs(nodeModulesDir)) {
      if (wanted.has(name)) {
        found.push({ name, dir, version: readVersion(dir) });
      }
      walk(path.join(dir, 'node_modules'));
    }
  };
  walk(root);
  return found;
}

/**
 * @returns {{ok: boolean, lines: string[]}}
 */
function checkFloors(root, floors = FLOORS) {
  const wanted = new Set(Object.keys(floors));
  const copies = findInstalledCopies(root, wanted);
  const lines = [];
  let ok = true;
  for (const name of Object.keys(floors)) {
    const floor = floors[name];
    const mine = copies.filter(c => c.name === name);
    if (mine.length === 0) {
      ok = false;
      lines.push(
        `FAIL ${name}: not installed under ${root} (floor >= ${floor})`
      );
      continue;
    }
    for (const copy of mine) {
      const rel = path.relative(root, copy.dir) || '.';
      const cmp = compareVersions(copy.version, floor);
      if (Number.isNaN(cmp)) {
        ok = false;
        lines.push(
          `FAIL ${name}@${copy.version} at ${rel}: unparseable version (floor >= ${floor})`
        );
      } else if (cmp < 0) {
        ok = false;
        lines.push(
          `FAIL ${name}@${copy.version} at ${rel}: below floor ${floor}`
        );
      } else {
        lines.push(
          `ok   ${name}@${copy.version} at ${rel} (floor >= ${floor})`
        );
      }
    }
  }
  return { ok, lines };
}

function main(argv) {
  const root = path.resolve(
    argv[2] || path.join(__dirname, '..', 'node_modules')
  );
  const { ok, lines } = checkFloors(root);
  for (const line of lines) {
    (ok ? console.log : console.error)(line);
  }
  if (!ok) {
    console.error(
      'check-dep-floors: dependency floor violated — refusing to build/ship this tree'
    );
    return 1;
  }
  console.log('check-dep-floors: all floors satisfied');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { FLOORS, checkFloors, compareVersions, findInstalledCopies };
