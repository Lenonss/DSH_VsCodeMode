import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, chmod, readdir, readFile, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeRequest, validAck, readConfig, privatePath, sendOpen, webTarget } from '../assets/shell/dsh-open.mjs';

let root;
let config;

/** @author ddj 2026-09-28 @param {string} folder Test directory @returns {void} Apply host-equivalent private Windows ACL. */
function lockFolder(folder) {
  if (process.platform !== 'win32') return;
  const script = "$ErrorActionPreference='Stop';$p=$env:DSH_TEST_FOLDER;" +
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=[Security.AccessControl.DirectorySecurity]::new();" +
    "$a.SetAccessRuleProtection($true,$false);" +
    "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));" +
    '[IO.Directory]::SetAccessControl($p,$a)';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: 'inherit', env: { ...process.env, DSH_TEST_FOLDER: folder },
  });
  assert.equal(result.status, 0);
}

/** @author ddj 2026-09-28 @returns {Promise<void>} Create only disposable workspace fixtures, never install OS integrations. */
async function setup() {
  root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.native-open-'));
  const inbox = join(root, 'inbox');
  await mkdir(inbox, { mode: 0o700 });
  lockFolder(inbox);
  await mkdir(join(inbox, 'requests'), { mode: 0o700 });
  await mkdir(join(inbox, 'acks'), { mode: 0o700 });
  config = { profile: root, inbox, mode: 'desktop' };
}

/** @author ddj 2026-09-28 @returns {Promise<void>} Remove only this test's generated directory. */
async function cleanup() { if (root) await rm(root, { recursive: true, force: true }); }
before(setup);
after(cleanup);

/** @author ddj 2026-09-28 @param {object} request Input request @returns {object} Matching host receipt. */
function receipt(request) {
  return { version: 1, requestId: request.requestId, profile: request.profile, createdAt: Date.now(), success: true };
}

/** @author ddj 2026-09-28 @param {Function} change Receipt transform @param {number} timeout ACK deadline @returns {Promise<object>} Run against a minimal atomic disk consumer. */
async function roundTrip(change = receipt, timeout = 30_000) {
  const pending = new Set();
  let hostError;
  /** @author ddj 2026-09-28 @returns {Promise<void>} Consume one request and publish a response atomically. */
  async function consume() {
    try {
      for (const name of await readdir(join(config.inbox, 'requests'))) {
        if (!name.endsWith('.json') || pending.has(name)) continue;
        pending.add(name);
        const file = join(config.inbox, 'requests', name);
        const request = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(name, request.requestId + '.json');
        assert.deepEqual(request.paths, [join(root, '代码 "quoted", café.cs')]);
        assert.equal(request.line, 42);
        assert.equal(request.column, 3);
        const ack = change(request);
        if (ack !== null) {
          const destination = join(config.inbox, 'acks', name);
          await writeFile(destination + '.tmp', JSON.stringify(ack), { flag: 'wx', mode: 0o600 });
          await rename(destination + '.tmp', destination);
        }
        await rm(file);
      }
    } catch (error) { hostError = error; }
  }
  const timer = setInterval(consume, 40);
  try {
    return await sendOpen(config, [join(root, '代码 "quoted", café.cs')], { line: 42, column: 3, timeout, activate: async () => {} });
  } finally {
    clearInterval(timer);
    if (hostError) throw hostError;
  }
}

test('request bounds, absolute paths, control characters and line coordinates fail closed', () => {
  const path = join(root, 'file.cs');
  assert.throws(() => makeRequest(config, []), /between 1 and 20/);
  assert.throws(() => makeRequest(config, Array(21).fill(path)), /between 1 and 20/);
  assert.throws(() => makeRequest(config, ['relative.cs']), /absolute/);
  assert.throws(() => makeRequest(config, [path + '\n']), /absolute/);
  assert.throws(() => makeRequest(config, [path + 'x'.repeat(8192)]), /8192/);
  assert.throws(() => makeRequest(config, Array(20).fill(path + 'x'.repeat(4000))), /64 KiB/);
  assert.throws(() => makeRequest(config, [path], { line: 0 }), /line/);
  assert.throws(() => makeRequest(config, [path], { column: 1.5 }), /column/);
});

test('only matching fresh and typed ACKs validate', () => {
  const request = makeRequest(config, [root]);
  const ack = receipt(request);
  assert.equal(validAck(ack, request), true);
  for (const patch of [{ requestId: 'unknown' }, { profile: root + '/other' }, { version: 2 },
    { success: 'true' }, { error: 1 }, { unexpected: true }, { success: undefined }, { createdAt: request.createdAt - 1 }, { createdAt: Date.now() + 6000 }]) {
    assert.equal(validAck({ ...ack, ...patch }, request), false);
  }
  assert.equal(validAck(null, request), false);
  assert.equal(validAck(ack, request, ack.createdAt + 60_001), false);
});

test('configuration needs explicit mode/profile/inbox and preserves selected Web base', async () => {
  const file = join(root, 'dsh-open.ini');
  await writeFile(file, `base=https://example.test/dsh\nmode=web\nprofile=${root}\ninbox=${config.inbox}\n`);
  const parsed = await readConfig(file);
  assert.equal(parsed.base, 'https://example.test/dsh');
  assert.equal(parsed.profile, root);
  await writeFile(file, 'base=http://127.0.0.1:9131\n');
  await assert.rejects(readConfig(file), /absolute profile/);
  assert.throws(() => webTarget('https://user:secret@example.test/'), /Invalid/);
  assert.throws(() => webTarget('https://example.test/?edrvPaths=x'), /Invalid/);
  assert.throws(() => webTarget('file:///tmp/test'), /Invalid/);
});

test('a real private directory accepts publication and a matching positive ACK', async () => {
  const ack = await roundTrip();
  assert.equal(ack.success, true);
  assert.deepEqual(await readdir(join(config.inbox, 'requests')), []);
});

test('host rejection is not reported as success', async () => {
  await assert.rejects(roundTrip(request => ({ ...receipt(request), success: false, error: 'editor unavailable' })), /editor unavailable/);
});

test('wrong-profile ACK is rejected even when it claims success', async () => {
  await assert.rejects(roundTrip(request => ({ ...receipt(request), profile: root + '/another-profile' })), /mismatched/);
});

test('missing ACK times out rather than claiming success', async () => {
  await assert.rejects(roundTrip(() => null, 1), /Timed out/);
});

test('a linked queue path is rejected before any write', async () => {
  const link = join(root, 'linked-inbox');
  await symlink(config.inbox, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(privatePath(link), /Linked/);
});

test('a non-private directory is rejected and never repaired by the producer', async () => {
  const insecure = join(root, 'public');
  await mkdir(insecure, { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(insecure, 0o755);
  await assert.rejects(privatePath(insecure), /private|failed/);
});
