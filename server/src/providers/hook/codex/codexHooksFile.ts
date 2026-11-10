/**
 * Install / uninstall Pixel Kaisha's entries in a Codex `hooks.json`:
 * `<project>/.codex/hooks.json` when hooks are project-scoped
 * (PIXEL_KAISHA_HOOKS_PROJECT_DIR), else `~/.codex/hooks.json`.
 * Never touches `config.toml` (where Codex keeps hook trust).
 *
 * Our entries are recognised by the script name in their command; other
 * hooks in the file are preserved untouched.
 */

import * as os from 'os';
import * as path from 'path';

import { bundledScriptPath } from '../claude/bundledScripts.js';
import { hooksProjectDir } from '../shared/hooksScope.js';
import {
  backupOnce,
  finishUninstall,
  readJsonObject,
  writeJsonAtomic,
} from '../shared/jsonSettingsFile.js';
import {
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_SCRIPT_NAME,
  CODEX_HOOK_TIMEOUT_SEC,
  CODEX_MATCHER_EVENTS,
} from './constants.js';

interface Handler {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}
interface Group {
  matcher?: string;
  hooks?: Handler[];
  [key: string]: unknown;
}

export function codexHooksFilePath(): string {
  const projectDir = hooksProjectDir();
  return projectDir
    ? path.join(projectDir, '.codex', 'hooks.json')
    : path.join(os.homedir(), '.codex', 'hooks.json');
}

/** The command Codex runs. Stable across versions on purpose: Codex trusts a
 *  hook by the hash of its definition, so changing it would need re-trust. */
export function codexHookCommand(): string {
  return `node "${bundledScriptPath(CODEX_HOOK_SCRIPT_NAME)}"`;
}

function isOurs(handler: unknown): boolean {
  return (
    typeof handler === 'object' &&
    handler !== null &&
    typeof (handler as Handler).command === 'string' &&
    (handler as Handler).command!.includes(CODEX_HOOK_SCRIPT_NAME)
  );
}

function hooksTable(settings: Record<string, unknown>): Record<string, Group[]> {
  const raw = settings.hooks;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, Group[]>)
    : {};
}

/** Remove our handlers from every event; drop groups/events left empty. */
function stripOurs(table: Record<string, Group[]>): Record<string, Group[]> {
  const out: Record<string, Group[]> = {};
  for (const [event, groups] of Object.entries(table)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept: Group[] = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => !isOurs(h));
      if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

export function installCodexHooks(file = codexHooksFilePath()): void {
  const settings = readJsonObject(file) ?? {};
  backupOnce(file);
  const table = stripOurs(hooksTable(settings));
  const handler: Handler = {
    type: 'command',
    command: codexHookCommand(),
    timeout: CODEX_HOOK_TIMEOUT_SEC,
  };
  for (const event of CODEX_HOOK_EVENTS) {
    const group: Group = CODEX_MATCHER_EVENTS.has(event)
      ? { matcher: '*', hooks: [handler] }
      : { hooks: [handler] };
    table[event] = [...(table[event] ?? []), group];
  }
  writeJsonAtomic(file, { ...settings, hooks: table });
}

export function uninstallCodexHooks(file = codexHooksFilePath()): void {
  const settings = readJsonObject(file);
  if (settings === null) return;
  const table = stripOurs(hooksTable(settings));
  const rest: Record<string, unknown> = { ...settings };
  if (Object.keys(table).length > 0) rest.hooks = table;
  else delete rest.hooks;
  finishUninstall(file, rest, Object.keys(rest).length === 0);
}

export function codexHooksInstalled(file = codexHooksFilePath()): boolean {
  try {
    const settings = readJsonObject(file);
    if (!settings) return false;
    return Object.values(hooksTable(settings)).some(
      (groups) =>
        Array.isArray(groups) &&
        groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs)),
    );
  } catch {
    return false;
  }
}
