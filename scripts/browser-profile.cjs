'use strict';
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { encryptState, decryptState } = require('./funda-browser-session.cjs');
const MAX_ARCHIVE = 128 * 1024 * 1024;
// Chrome writes plaintext only to ephemeral container storage. The volume holds AES-GCM archives.
async function restoreProfile(profile, archiveFile, key) {
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  let encrypted;
  try {
    if ((await fs.stat(archiveFile)).size > MAX_ARCHIVE * 2) throw Error('PROFILE_TOO_LARGE');
    encrypted = await fs.readFile(archiveFile);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const payload = decryptState(encrypted, key);
  if (payload.format !== 1 || typeof payload.archive !== 'string') throw Error('PROFILE_FORMAT');
  const archive = Buffer.from(payload.archive, 'base64');
  if (archive.length > MAX_ARCHIVE) throw Error('PROFILE_TOO_LARGE');
  const temporary = profile + '.tar.gz';
  try {
    await fs.writeFile(temporary, archive, { mode: 0o600 });
    await run('tar', ['-xzf', temporary, '-C', profile], { timeout: 30000 });
    // Locks identify the previous container and must not be restored.
    for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) await fs.rm(profile + '/' + file, { force: true });
    return true;
  } finally { await fs.rm(temporary, { force: true }); }
}
async function saveProfile(profile, archiveFile, key) {
  const temporary = profile + '.tar.gz';
  try {
    // Call only after Chrome closes so SQLite databases are consistent.
    await run('tar', ['-czf', temporary, '--exclude=Singleton*', '--exclude=*/Cache', '--exclude=*/Code Cache',
      '--exclude=*/GPUCache', '--exclude=*/Crashpad', '-C', profile, '.'], { timeout: 30000 });
    if ((await fs.stat(temporary)).size > MAX_ARCHIVE) throw Error('PROFILE_TOO_LARGE');
    const archive = await fs.readFile(temporary);
    await fs.writeFile(archiveFile + '.tmp', encryptState({ format: 1, archive: archive.toString('base64') }, key), { mode: 0o600 });
    await fs.rename(archiveFile + '.tmp', archiveFile);
  } finally { await fs.rm(temporary, { force: true }); }
}
module.exports = { restoreProfile, saveProfile };
