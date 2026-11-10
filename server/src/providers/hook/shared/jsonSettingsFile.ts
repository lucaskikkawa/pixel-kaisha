/**
 * Small, careful read/modify/write for a CLI's JSON hook settings file.
 *
 * - The first time we touch a file we record what was there before: a copy at
 *   `<file>.pixel-kaisha.backup`, or a marker saying the file did not exist.
 * - Writes are atomic (temp file + rename) and new files are created 0600.
 * - A file we cannot parse is never rewritten: the operation throws instead.
 */

import * as fs from 'fs';
import * as path from 'path';

export const BACKUP_SUFFIX = '.pixel-kaisha.backup';
/** Content of the backup when the original file did not exist. */
export const ABSENT_MARKER = '__pixel_kaisha_original_absent__\n';

export class UnparseableSettingsError extends Error {}

export function readJsonObject(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnparseableSettingsError(`Couldn't parse ${file}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UnparseableSettingsError(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Record the pre-install state once (never overwritten afterwards). */
export function backupOnce(file: string): void {
  const backup = file + BACKUP_SUFFIX;
  if (fs.existsSync(backup)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  else fs.writeFileSync(backup, ABSENT_MARKER, { mode: 0o600 });
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.pixel-kaisha.tmp-${process.pid}`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

/**
 * After our entries are removed: if nothing but an empty shell is left and the
 * file did not exist before we installed, remove it (restores the original
 * state exactly); otherwise write what is left. The backup is then dropped.
 */
export function finishUninstall(
  file: string,
  remaining: Record<string, unknown>,
  isEmpty: boolean,
): void {
  const backup = file + BACKUP_SUFFIX;
  const wasAbsent = fs.existsSync(backup) && fs.readFileSync(backup, 'utf8') === ABSENT_MARKER;
  if (isEmpty && wasAbsent) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else if (!wasAbsent && fs.existsSync(backup) && sameJson(backup, remaining)) {
    // Nothing of ours left and nothing else changed: put the original bytes back.
    fs.copyFileSync(backup, file);
  } else {
    writeJsonAtomic(file, remaining);
  }
  if (fs.existsSync(backup)) fs.unlinkSync(backup);
}

function sameJson(file: string, value: unknown): boolean {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const original: unknown = text.trim() === '' ? {} : JSON.parse(text);
    return JSON.stringify(original) === JSON.stringify(value);
  } catch {
    return false;
  }
}
