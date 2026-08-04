import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isSecretFile, checkGitConflict, pruneOldTransfers, buildTransferSnapshot } from '../plugins/gemini/scripts/lib/transfer-context.mjs';

test('isSecretFile correctly identifies sensitive credential file patterns', () => {
  assert.equal(isSecretFile('.env'), true);
  assert.equal(isSecretFile('.env.local'), true);
  assert.equal(isSecretFile('.npmrc'), true);
  assert.equal(isSecretFile('cert.p12'), true);
  assert.equal(isSecretFile('server.key'), true);
  assert.equal(isSecretFile('cert.pem'), true);
  assert.equal(isSecretFile('oauth_creds.json'), true);
  assert.equal(isSecretFile('secrets.yml'), true);
  assert.equal(isSecretFile('index.js'), false);
  assert.equal(isSecretFile('README.md'), false);
});

test('checkGitConflict detects active git merge/rebase heads', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-conflict-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  assert.equal(checkGitConflict(tmpDir), null);

  fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), 'abc1234');
  assert.equal(checkGitConflict(tmpDir), 'MERGE_HEAD');
});

test('pruneOldTransfers keeps only maxKeep latest JSON files', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-prune-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const transfersDir = path.join(tmpDir, '.omc', 'transfers');
  fs.mkdirSync(transfersDir, { recursive: true });

  for (let i = 1; i <= 25; i++) {
    const filename = `transfer-test${i.toString().padStart(2, '0')}.json`;
    fs.writeFileSync(path.join(transfersDir, filename), JSON.stringify({ id: i }));
  }

  pruneOldTransfers(transfersDir, 20);

  const remaining = fs.readdirSync(transfersDir).filter((f) => f.endsWith('.json'));
  assert.equal(remaining.length, 20);
});

test('buildTransferSnapshot enforces model and effort exclusivity', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-excl-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  assert.throws(() => {
    buildTransferSnapshot({ cwd: tmpDir, model: 'gemini-3.5-pro', effort: 'high', instructions: 'test' });
  }, /specify either --model or --effort, not both/);
});

test('buildTransferSnapshot creates valid snapshot with model and effort', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-valid-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { snapshot, snapshotPath } = buildTransferSnapshot({
    cwd: tmpDir,
    instructions: 'Finish refactoring $var in "Login" module',
    engine: 'agy',
    effort: 'high',
  });

  assert.ok(snapshot.transferId.startsWith('transfer-'));
  assert.equal(snapshot.effort, 'high');
  assert.equal(snapshot.model, null);
  assert.ok(fs.existsSync(snapshotPath));

  const content = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(content.effort, 'high');
});
