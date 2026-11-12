import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CharacterProfile } from '../../core/src/characterProfiles.js';
import { normalizeMemoryPath } from '../../core/src/characterProfiles.js';
import type { CharacterMemory } from '../../core/src/messages.js';
import {
  MEMORY_BINARY_SNIFF_BYTES,
  MEMORY_FOLDER_FILE_RE,
  MEMORY_READ_MAX_BYTES,
} from './constants.js';

/**
 * Pixel Kaisha B2.4 (docs/kaisha/protocol-memory.md): a character's tool memory, READ ONLY.
 * The profile stores only a path (`memoryPath`: a CLAUDE.md, AGENTS.md or GEMINI.md file,
 * or a ~/.claude/projects/<proj>/memory/ folder); this module reads what is there on
 * request. It never writes, creates, moves or changes the mode of anything: the only fs
 * calls are stat, readdir, open('r'), read and close. A path that isn't there, isn't
 * readable or is too big is a `warning`, never a throw. The content is never logged.
 */

/** Why a reply carries no (or not all) content. */
export type MemoryWarning =
  | 'not-found'
  | 'not-a-file'
  | 'too-large'
  | 'unreadable'
  | 'no-path'
  | 'invalid-path'
  | 'unknown-profile';

/** A read's outcome, without the message's type and profileId. */
export type MemoryRead = Omit<CharacterMemory, 'type' | 'profileId'> & { warning?: MemoryWarning };

/** `raw` with a leading '~' expanded to `home`, resolved and normalized; '' when it isn't a
 *  memory path at all (relative, '~user', blank, too long). */
export function resolveMemoryPath(raw: string, home: string = os.homedir()): string {
  const kept = normalizeMemoryPath(raw);
  if (kept === undefined) return '';
  const expanded = kept.startsWith('~') ? path.join(home, kept.slice(1)) : kept;
  return path.resolve(expanded);
}

/** The warning an fs error stands for: gone (or a parent that is a file) = not-found. */
function warningOf(err: unknown): MemoryWarning {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unreadable';
}

type TextRead = { text: string } | { warning: MemoryWarning };

/**
 * A regular file's UTF-8 text, at most `maxBytes` (one byte more is read to tell a file that
 * outgrew the cap since its stat). A NUL in its first bytes = binary = unreadable.
 */
async function readText(file: string, maxBytes: number): Promise<TextRead> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { warning: 'not-a-file' };
    if (stat.size > maxBytes) return { warning: 'too-large' };
    const buf = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buf.length) {
      const { bytesRead } = await handle.read(buf, length, buf.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { warning: 'too-large' };
    if (buf.subarray(0, Math.min(length, MEMORY_BINARY_SNIFF_BYTES)).includes(0)) {
      return { warning: 'unreadable' };
    }
    return { text: buf.toString('utf-8', 0, length) };
  } catch (err) {
    return { warning: warningOf(err) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The header a folder's file is joined under: `\n\n--- name ---\n\n`, without the leading
 *  blank line for the first file. */
const fileHeader = (name: string, first: boolean) => `${first ? '' : '\n\n'}--- ${name} ---\n\n`;

/**
 * A memory folder: its direct regular files named *.md / *.markdown / *.txt (not hidden, not
 * recursive, symlinks not followed), by name, joined under a `--- name ---` header each,
 * until MEMORY_READ_MAX_BYTES. A file that doesn't fit is left out with `too-large` (the ones
 * that fit are still sent); a binary or unreadable one is skipped. No such file = content ''.
 */
async function readFolder(dir: string): Promise<MemoryRead> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { path: dir, warning: warningOf(err) };
  }
  const names = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && MEMORY_FOLDER_FILE_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  const files: string[] = [];
  let content = '';
  let left = MEMORY_READ_MAX_BYTES;
  let warning: MemoryWarning | undefined;
  for (const name of names) {
    const header = fileHeader(name, files.length === 0);
    const room = left - Buffer.byteLength(header);
    const read =
      room > 0 ? await readText(path.join(dir, name), room) : { warning: 'too-large' as const };
    if ('warning' in read) {
      if (read.warning === 'too-large') warning = 'too-large';
      continue;
    }
    content += header + read.text;
    left -= Buffer.byteLength(header) + Buffer.byteLength(read.text);
    files.push(name);
  }
  return { path: dir, content, files, ...(warning && { warning }) };
}

/**
 * Read the memory at `raw` (a profile's memoryPath or a request's override). Never throws.
 * A file comes back whole (≤ 256 KiB) or as a warning; a folder as its files joined.
 */
export async function readCharacterMemory(
  raw: string,
  home: string = os.homedir(),
): Promise<MemoryRead> {
  const resolved = resolveMemoryPath(raw, home);
  if (!resolved) return { path: '', warning: 'invalid-path' };
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (err) {
    return { path: resolved, warning: warningOf(err) };
  }
  if (stat.isDirectory()) return readFolder(resolved);
  if (!stat.isFile()) return { path: resolved, warning: 'not-a-file' };
  const read = await readText(resolved, MEMORY_READ_MAX_BYTES);
  return 'warning' in read
    ? { path: resolved, warning: read.warning }
    : { path: resolved, content: read.text };
}

/**
 * The `characterMemory` reply to a `requestCharacterMemory` (unvalidated off the wire).
 * A string `path` override is read as is, whether or not the profile is saved yet (the
 * editor may preview a draft's path); otherwise the profile's stored memoryPath. Never throws.
 */
export async function buildCharacterMemory(
  msg: { profileId?: unknown; path?: unknown },
  profiles: readonly CharacterProfile[],
  home: string = os.homedir(),
): Promise<CharacterMemory> {
  const profileId = typeof msg.profileId === 'string' ? msg.profileId : '';
  const reply = (read: MemoryRead): CharacterMemory => ({
    type: 'characterMemory',
    profileId,
    ...read,
  });
  if (msg.path !== undefined) {
    if (typeof msg.path !== 'string') return reply({ path: '', warning: 'invalid-path' });
    return reply(await readCharacterMemory(msg.path, home));
  }
  const profile = profileId ? profiles.find((p) => p.id === profileId) : undefined;
  if (!profile) return reply({ path: '', warning: 'unknown-profile' });
  if (!profile.memoryPath) return reply({ path: '', warning: 'no-path' });
  return reply(await readCharacterMemory(profile.memoryPath, home));
}
