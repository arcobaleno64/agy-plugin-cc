import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isSecretFile, checkGitConflict, pruneOldTransfers, buildTransferSnapshot } from '../plugins/gemini/scripts/lib/transfer-context.mjs';
import { parseTransferArgs } from '../plugins/gemini/scripts/transfer.mjs';

// The slash command passes the entire user tail as one quoted "$ARGUMENTS"
// token, so flags only work if that single string is re-split first.
test('parseTransferArgs splits a single quoted $ARGUMENTS string into flags and instructions', () => {
  const parsed = parseTransferArgs(['--engine agy --effort high finish the login refactor']);

  assert.equal(parsed.engine, 'agy');
  assert.equal(parsed.effort, 'high');
  assert.equal(parsed.model, null);
  assert.equal(parsed.instructions, 'finish the login refactor');
});

test('parseTransferArgs handles a pre-split argv and --flag=value form', () => {
  const parsed = parseTransferArgs(['--engine=gemini', '--model', 'gemini-3.5-pro', 'continue', 'here']);

  assert.equal(parsed.engine, 'gemini');
  assert.equal(parsed.model, 'gemini-3.5-pro');
  assert.equal(parsed.instructions, 'continue here');
});

test('parseTransferArgs defaults to auto and keeps --json out of the instructions', () => {
  const parsed = parseTransferArgs(['--json hand off the current state']);

  assert.equal(parsed.engine, 'auto');
  assert.equal(parsed.instructions, 'hand off the current state');
});

test('parseTransferArgs rejects an unknown engine', () => {
  assert.throws(() => parseTransferArgs(['--engine copilot']), /Unknown engine "copilot"/);
});

test('parseTransferArgs treats an empty $ARGUMENTS as no arguments', () => {
  const parsed = parseTransferArgs(['']);

  assert.equal(parsed.engine, 'auto');
  assert.equal(parsed.instructions, '');
});

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
