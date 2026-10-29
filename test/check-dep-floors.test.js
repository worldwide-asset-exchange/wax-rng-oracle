// scripts/check-dep-floors.js: fails on an installed node-forge < 1.4.0 or
// @waxio/rsa-threshold-signatures < 2.0.0 (hoisted OR nested), passes on the
// real tree. Exercised both through the module API and as a process.
const { expect } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkFloors, compareVersions } = require('../scripts/check-dep-floors');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-dep-floors.js');
const REAL_ROOT = path.join(__dirname, '..', 'node_modules');

function scratchTree(packages) {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dep-floors-')),
    'node_modules'
  );
  for (const [rel, version] of Object.entries(packages)) {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: rel.split('node_modules/').pop(), version })
    );
  }
  return root;
}

function runScript(root) {
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
}

describe('check-dep-floors', () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('compares versions numerically with prereleases below the release', () => {
    expect(compareVersions('1.4.0', '1.3.1')).to.be.greaterThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).to.be.greaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).to.equal(0);
    expect(compareVersions('2.0.0-rc.1', '2.0.0')).to.be.lessThan(0);
    expect(compareVersions('garbage', '2.0.0')).to.be.NaN;
  });

  it('fails on node-forge 1.3.1 and rsa-threshold-signatures 1.3.0 (the pre-fix pins)', () => {
    const root = scratchTree({
      'node-forge': '1.3.1',
      '@waxio/rsa-threshold-signatures': '1.3.0',
    });
    roots.push(root);
    const { ok, lines } = checkFloors(root);
    expect(ok).to.equal(false);
    expect(lines.join('\n')).to.match(
      /FAIL node-forge@1\.3\.1 .*below floor 1\.4\.0/
    );
    expect(lines.join('\n')).to.match(
      /FAIL @waxio\/rsa-threshold-signatures@1\.3\.0 .*below floor 2\.0\.0/
    );
    const proc = runScript(root);
    expect(proc.status).to.equal(1);
    expect(proc.stderr).to.include('below floor');
  });

  it('fails when a nested copy is below the floor even though the hoisted one passes', () => {
    const root = scratchTree({
      'node-forge': '1.4.0',
      '@waxio/rsa-threshold-signatures': '2.0.0',
      '@waxio/rsa-threshold-signatures/node_modules/node-forge': '1.3.1',
    });
    roots.push(root);
    const { ok, lines } = checkFloors(root);
    expect(ok).to.equal(false);
    expect(lines.filter(l => l.startsWith('FAIL'))).to.have.length(1);
    expect(lines.find(l => l.startsWith('FAIL'))).to.include(
      path.join(
        '@waxio',
        'rsa-threshold-signatures',
        'node_modules',
        'node-forge'
      )
    );
  });

  it('fails when a floored package is missing altogether', () => {
    const root = scratchTree({ 'node-forge': '1.4.0' });
    roots.push(root);
    const { ok, lines } = checkFloors(root);
    expect(ok).to.equal(false);
    expect(lines.join('\n')).to.include(
      'rsa-threshold-signatures: not installed'
    );
  });

  it('passes on the installed tree (and the npm script uses it)', () => {
    const { ok, lines } = checkFloors(REAL_ROOT);
    expect(ok, lines.join('\n')).to.equal(true);
    expect(lines.join('\n')).to.match(
      /ok {3}node-forge@1\.(4|[5-9]|\d\d)\.\d+/
    );
    expect(lines.join('\n')).to.match(
      /ok {3}@waxio\/rsa-threshold-signatures@([2-9]|\d\d)\.\d+\.\d+/
    );
    const proc = runScript(REAL_ROOT);
    expect(proc.status, proc.stderr).to.equal(0);
    expect(proc.stdout).to.include('all floors satisfied');
  });
});
