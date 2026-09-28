#!/usr/bin/env node
// Shared OPEN REQUEST/ACK producer. No HTTP/RPC or browser credentials.
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 64 * 1024;
const TTL = 60_000;

/** @author ddj 2026-09-28 @param {string} file INI path @returns {Promise<object>} Validated bridge metadata. */
export async function readConfig(file) {
  if (!isAbsolute(file)) throw new Error('Bridge configuration must be an absolute path.');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid bridge configuration.');
  const config = Object.create(null);
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z]+)\s*=(.*)$/.exec(line);
    if (match) config[match[1].toLowerCase()] = match[2].trim();
  }
  for (const key of ['profile', 'inbox']) {
    if (!config[key] || !isAbsolute(config[key]) || config[key].length > 8192) throw new Error('Missing absolute ' + key + ' in bridge configuration.');
  }
  if (!['desktop', 'web'].includes(config.mode)) throw new Error('Bridge mode must be desktop or web.');
  if (config.mode === 'web') webTarget(config.base);
  return config;
}

/** @author ddj 2026-09-28 @param {string} value Selected base URL @returns {string} Safe, unchanged wake target. */
export function webTarget(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid selected Web base URL.');
  }
  return value;
}

/** @author ddj 2026-09-28 @param {string} path Filesystem path @returns {Promise<void>} Reject linked ancestors. */
async function noLinks(path) {
  let cursor = resolve(path);
  while (true) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('Linked bridge paths are not allowed: ' + cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const physical = await realpath(path);
  const equal = process.platform === 'win32'
    ? physical.toLowerCase() === resolve(path).toLowerCase()
    : physical === resolve(path);
  if (!equal) throw new Error('Bridge path escapes its physical location.');
}

/** @author ddj 2026-09-28 @param {string} path Private directory or file @returns {Promise<void>} Validate Windows owner and ACL. */
async function windowsAcl(path) {
  const script = "$ErrorActionPreference='Stop'; $p=$env:DSH_OPEN_CHECK; " +
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "if([IO.Directory]::Exists($p)) { $a=[IO.Directory]::GetAccessControl($p);$f=[IO.DirectoryInfo]::new($p) } " +
    "else { $a=[IO.File]::GetAccessControl($p);$f=[IO.FileInfo]::new($p) }; " +
    "if ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 4 }; " +
    "$rules=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); $allow=$false; " +
    "foreach($r in $rules) { if($r.AccessControlType -eq 'Allow' -and $r.FileSystemRights -ne 0) { " +
    "if($r.IdentityReference.Value -ne $sid.Value) { exit 5 }; $allow=$true } }; " +
    "if(-not $allow) { exit 6 }; " +
    "while($null -ne $f) { if(($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 7 }; " +
    "if($f -is [IO.FileInfo]) { $f=$f.Directory } else { $f=$f.Parent } }";
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await runProcess(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, DSH_OPEN_CHECK: path }, windowsHide: true,
  });
}

/** @author ddj 2026-09-28 @param {string} path Queue entry @param {boolean} directory Expected kind @returns {Promise<void>} Enforce current-user-only access. */
export async function privatePath(path, directory = true) {
  await noLinks(path);
  const stat = await lstat(path);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw new Error('Invalid bridge entry type.');
  if (!directory && stat.size > MAX_BYTES) throw new Error('Bridge entry exceeds 64 KiB.');
  if (process.platform === 'win32') return windowsAcl(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
    throw new Error('Bridge entry is not private to the current user: ' + path);
  }
}

/** @author ddj 2026-09-28 @param {object} config Bridge metadata @returns {Promise<void>} Validate existing host-owned queue; never create directories. */
async function checkQueue(config) {
  await privatePath(config.inbox);
  await privatePath(join(config.inbox, 'requests'));
  await privatePath(join(config.inbox, 'acks'));
}

/** @author ddj 2026-09-28 @param {object} config Bridge metadata @param {string[]} paths Absolute inputs @param {object} position Optional line/column @returns {object} Validated request. */
export function makeRequest(config, paths, position = {}) {
  if (!config.profile || !isAbsolute(config.profile)) throw new Error('Missing absolute profile.');
  if (!paths.length || paths.length > 20) throw new Error('Open requires between 1 and 20 paths.');
  if (paths.some(path => typeof path !== 'string' || !isAbsolute(path) || path.length > 8192 || /[\u0000-\u001f]/.test(path))) {
    throw new Error('Open paths must be absolute and at most 8192 characters.');
  }
  const request = { version: 1, requestId: randomUUID(), profile: config.profile, paths, createdAt: Date.now() };
  for (const key of ['line', 'column']) {
    if (position[key] === undefined) continue;
    if (!Number.isSafeInteger(position[key]) || position[key] <= 0) throw new Error('Invalid ' + key + '.');
    request[key] = position[key];
  }
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_BYTES) throw new Error('Open request exceeds 64 KiB.');
  return request;
}

/** @author ddj 2026-09-28 @param {object} config Bridge metadata @param {object} request Validated request @returns {Promise<void>} Exclusively publish an atomic JSON file. */
async function publish(config, request) {
  const folder = join(config.inbox, 'requests');
  const temp = join(folder, request.requestId + '.tmp');
  const target = join(folder, request.requestId + '.json');
  await checkQueue(config);
  let owned = false;
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    owned = true;
    try { await handle.writeFile(JSON.stringify(request), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await privatePath(temp, false);
    await checkQueue(config);
    // UUID + exclusive temporary creation prevents competing producers sharing this destination.
    try { await lstat(target); throw new Error('Request ID already exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temp, target);
    owned = false;
  } finally {
    if (owned) await unlink(temp).catch(() => {});
  }
}

/** @author ddj 2026-09-28 @param {object} ack Untrusted receipt @param {object} request Submitted request @param {number} now Clock @returns {boolean} Matching, fresh success only. */
export function validAck(ack, request, now = Date.now()) {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return false;
  const keys = ['version', 'requestId', 'profile', 'success', 'error', 'createdAt'];
  if (Object.keys(ack).some(key => !keys.includes(key)) || (ack.error !== undefined && typeof ack.error !== 'string')) return false;
  return ack.version === 1 && ack.requestId === request.requestId &&
    ack.profile === request.profile && typeof ack.success === 'boolean' && Number.isSafeInteger(ack.createdAt) &&
    ack.createdAt >= request.createdAt && ack.createdAt <= now + 5000 && now - ack.createdAt <= TTL;
}

/** @author ddj 2026-09-28 @param {number} ms Poll delay @returns {Promise<void>} Nonblocking timer. */
function pause(ms) { return new Promise(resolveWait => setTimeout(resolveWait, ms)); }

/** @author ddj 2026-09-28 @param {object} config Bridge metadata @param {object} request Submitted request @param {number} timeout Maximum ACK wait @param {Function} cancelWake Cancel deferred activation @returns {Promise<object>} Confirmed receipt, or throw. */
async function waitAck(config, request, timeout, cancelWake) {
  const file = join(config.inbox, 'acks', request.requestId + '.json');
  const deadline = request.createdAt + Math.min(timeout, TTL);
  while (Date.now() < deadline) {
    try {
      const stat = await lstat(file);
      cancelWake();
      if (stat.size > MAX_BYTES) throw new Error('ACK exceeds 64 KiB.');
      await checkQueue(config);
      await privatePath(file, false);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let ack;
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size > MAX_BYTES || current.nlink !== 1 || current.ino !== stat.ino || current.dev !== stat.dev) {
          throw new Error('Invalid or replaced ACK file.');
        }
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) throw new Error('ACK exceeds 64 KiB.');
        ack = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally { await handle.close(); }
      if (!validAck(ack, request)) throw new Error('Invalid or mismatched OPEN ACK.');
      if (!ack.success) throw new Error(typeof ack.error === 'string' ? ack.error : 'DSH rejected the open request.');
      return ack;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(100);
  }
  throw new Error('Timed out waiting for DSH OPEN ACK; opening was not confirmed.');
}

/** @author ddj 2026-09-28 @param {string} executable Program @param {string[]} args Arguments @param {object} options Spawn options @returns {Promise<void>} Require a successful process exit. */
function runProcess(executable, args, options = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(executable, args, { stdio: 'ignore', timeout: 10_000, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveExit() : reject(new Error('Bridge process failed (' + code + ').')));
  });
}

/** @author ddj 2026-09-28 @param {object} config Bridge metadata @returns {Promise<void>} Wake only the official desktop URI or selected Web base. */
async function wake(config) {
  const target = config.mode === 'desktop' ? 'dsh://open' : webTarget(config.base);
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = "$ErrorActionPreference='Stop';$s=[Diagnostics.ProcessStartInfo]::new($env:DSH_OPEN_WAKE);" +
      "$s.UseShellExecute=$true;$s.WindowStyle=[Diagnostics.ProcessWindowStyle]::Normal;[Diagnostics.Process]::Start($s)|Out-Null";
    await runProcess(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, DSH_OPEN_WAKE: target }, windowsHide: true,
    });
  } else {
    await runProcess(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [target]);
  }
}

/** @author ddj 2026-09-28 @param {object} config Bridge metadata @param {string[]} paths Absolute inputs @param {object} options Position, timeout, activation callback @returns {Promise<object>} Confirmed ACK. */
export async function sendOpen(config, paths, options = {}) {
  const request = makeRequest(config, paths, options);
  await publish(config, request);
  // Give an already running client a chance to finish without opening another Web tab.
  const activate = options.activate || wake;
  const timer = setTimeout(() => { Promise.resolve(activate(config)).catch(() => {}); }, 700);
  try { return await waitAck(config, request, options.timeout ?? TTL, () => clearTimeout(timer)); }
  finally { clearTimeout(timer); }
}

/** @author ddj 2026-09-28 @param {string[]} args CLI arguments @returns {Promise<void>} Run producer and expose errors through exit status. */
async function main(args) {
  let configFile = join(dirname(fileURLToPath(import.meta.url)), 'dsh-open.ini');
  const options = {};
  let unity = false;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { index++; break; }
    if (arg === '--config') configFile = args[++index];
    else if (arg === '--line' || arg === '--column') options[arg.slice(2)] = Number(args[++index]);
    else if (arg === '--no-wake') unity = true;
    else throw new Error('Unknown launcher option: ' + arg);
  }
  const paths = args.slice(index).map(path => resolve(path));
  if (!paths.length) return;
  const config = await readConfig(configFile);
  if (unity) options.activate = async value => {
    process.stdout.write('DSH_WAKE:' + (value.mode === 'desktop' ? 'dsh://open' : webTarget(value.base)) + '\n');
  };
  await sendOpen(config, paths, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error('DSH OPEN: ' + error.message); process.exitCode = 1; });
}
