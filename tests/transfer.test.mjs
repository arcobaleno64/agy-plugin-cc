import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isSecretFile, checkGitConflict, pruneOldTransfers, buildTransferSnapshot, assertContained } from '../plugins/gemini/scripts/lib/transfer-context.mjs';
import { parseTransferArgs } from '../plugins/gemini/scripts/transfer.mjs';
import { initGitRepo, run } from './helpers.mjs';

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

// A snapshot's gitDiff field holds the whole uncommitted diff. Both READMEs said
// `.omc/` was excluded from version control, but the exclusion lived only in this
// repository's own .gitignore — so in any other repository the snapshot was
// untracked rather than ignored, showed up in `git status`, and `git add -A`
// committed it. Asserted through real git, because `git check-ignore` is the only
// thing that settles whether a rule actually applies.
test('a transfer snapshot is ignored by the repository it was written into', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-ignore-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const x = 1;\n');

  const { snapshotPath } = buildTransferSnapshot({ cwd: repo, instructions: 'hand off' });
  const relative = path.relative(repo, snapshotPath).split(path.sep).join('/');

  const ignored = run('git', ['check-ignore', '-q', relative], { cwd: repo });
  assert.equal(ignored.status, 0, `${relative} is not ignored, so git add -A would commit the working diff`);

  const status = run('git', ['status', '--porcelain'], { cwd: repo });
  assert.doesNotMatch(status.stdout, /\.omc/, 'the snapshot must not appear in git status');
});

// The ignore file is the user's once it exists: a repository that deliberately
// tracks something under .omc/ has said so, and a transfer is not the moment to
// overrule it.
test('an existing .omc/.gitignore is left exactly as the user wrote it', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-ignore-keep-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const omc = path.join(repo, '.omc');
  fs.mkdirSync(omc, { recursive: true });
  fs.writeFileSync(path.join(omc, '.gitignore'), '# mine\ntransfers/\n');

  buildTransferSnapshot({ cwd: repo, instructions: 'hand off' });

  assert.equal(fs.readFileSync(path.join(omc, '.gitignore'), 'utf8'), '# mine\ntransfers/\n');
});

// A snapshot holds the whole uncommitted diff, and where it lands is decided by
// what `.omc` resolves to, not by what it is named. A repository can ship a
// junction called `.omc` -- Windows lets an unprivileged user create one, so
// cloning a repository is enough -- and every snapshot then goes wherever that
// link points, while the returned `snapshotPath` still reads as a path inside
// the repository. Measured before the guard existed: the file landed outside and
// the reported path did not say so.
//
// `symlinkSync(..., 'junction')` is the portable spelling: Windows makes a
// junction, POSIX ignores the type and makes a directory symlink. Creating one
// still needs a privilege some Windows hosts withhold, and a test that cannot
// build its own fixture has not found a defect -- it has found a host that
// cannot run it, which must read as skipped rather than failed.
const canLink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-linkcheck-'));
  try {
    fs.symlinkSync(probe, path.join(probe, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})();
for (const [label, linkAt] of [['.omc', '.omc'], ['.omc/transfers', path.join('.omc', 'transfers')]]) {
  test(`a transfer refuses to follow a ${label} link out of the workspace`, { skip: !canLink }, (t) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-escape-repo-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-escape-out-'));
    t.after(() => {
      for (const dir of [repo, outside]) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });

    const link = path.join(repo, linkAt);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, 'junction');

    assert.throws(
      () => buildTransferSnapshot({ cwd: repo, instructions: 'hand off' }),
      /Refusing to write/,
      'the snapshot was written through the link'
    );
    // The message is not the point -- where the bytes went is. Nothing may have
    // reached the far side, including an empty directory the guard created on
    // its way to refusing.
    assert.deepEqual(fs.readdirSync(outside), [], 'something was written outside the workspace');
  });
}

// The same primitive one directory down, and the case the first version of the
// guard missed: `.omc` and `.omc/transfers` are both real directories, so both
// checks pass, and `.gitignore` inside them is a DANGLING link. `existsSync`
// follows it, finds nothing, returns false -- and `writeFileSync` then follows it
// too and creates the far-side file. Dangling is what makes it work: the guard
// resolved its target with realpath, which fails ENOENT on a link to nothing, and
// "cannot resolve" was being read as "not there yet".
//
// The content is fixed (`*\n`), so this creates or truncates rather than
// exfiltrating. It is still a repository choosing a path outside itself and
// getting a write there.
test('a transfer refuses a dangling .omc/.gitignore link', { skip: !canLink }, (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-ignore-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-ignore-out-'));
  t.after(() => {
    for (const dir of [repo, outside]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  // Both directories real, so the two directory guards have nothing to say.
  const omc = path.join(repo, '.omc');
  fs.mkdirSync(path.join(omc, 'transfers'), { recursive: true });

  const victim = path.join(outside, 'planted.txt');
  fs.symlinkSync(victim, path.join(omc, '.gitignore'), 'file');
  assert.equal(fs.existsSync(victim), false, 'the fixture must start dangling');

  assert.throws(
    () => buildTransferSnapshot({ cwd: repo, instructions: 'hand off' }),
    /Refusing to write/,
    'the link was followed'
  );
  assert.deepEqual(fs.readdirSync(outside), [], 'a file was created outside the workspace');
});

// The containment predicate, asserted directly. Every link fixture above is
// caught by the lstat check before it gets here, so nothing was exercising this
// branch -- making it always return left the whole suite green. It is the
// invariant the function is named for and it backstops any relocation lstat does
// not report as a link, so it is tested rather than trusted.
test('assertContained refuses a real directory that resolves outside the workspace', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'contained-root-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'contained-out-'));
  t.after(() => {
    for (const dir of [repo, elsewhere]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  // No link anywhere: two real directories that are simply not nested.
  assert.throws(
    () => assertContained(repo, elsewhere, 'probe'),
    /outside the workspace/,
    'a directory outside the workspace was accepted'
  );

  // Inside is accepted, and so is the root itself -- an empty relative path means
  // "this is the workspace", which is contained, and rejecting it would refuse a
  // write directly into the root.
  const inside = path.join(repo, 'nested');
  fs.mkdirSync(inside);
  assert.doesNotThrow(() => assertContained(repo, inside, 'probe'));
  assert.doesNotThrow(() => assertContained(repo, repo, 'probe'));

  // A path that does not exist yet is judged by its parent, not waved through.
  assert.doesNotThrow(() => assertContained(repo, path.join(inside, 'new.json'), 'probe'));
  assert.throws(() => assertContained(repo, path.join(elsewhere, 'new.json'), 'probe'), /outside the workspace/);
});

// The branch that decides whether this guard fails open or closed. ENOENT means
// "not there", and only that is benign. EACCES, EPERM and ELOOP all mean the
// guard could not answer -- on Windows a junction the process may traverse but
// not open reports exactly that way, and answering "contained" there hands back
// the original bug with a guard in front of it. None of these can be constructed
// portably, which is why they arrive through a seam.
test('assertContained fails closed when it cannot inspect the path', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'contained-errs-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const target = path.join(repo, '.omc');

  for (const code of ['EACCES', 'EPERM', 'ELOOP']) {
    assert.throws(
      () => assertContained(repo, target, '.omc', { lstatImpl: () => { const e = new Error(code); e.code = code; throw e; } }),
      new RegExp(`cannot be inspected \\(${code}\\)`),
      `${code} was treated as contained`
    );
  }

  // And ENOENT still is not an error: the path simply does not exist yet, and the
  // parent it would be created in is the workspace itself.
  assert.doesNotThrow(
    () => assertContained(repo, target, '.omc', { lstatImpl: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } })
  );
});
