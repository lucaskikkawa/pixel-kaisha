/**
 * Install / uninstall Pixel Kaisha's named hook in an agy `hooks.json`.
 *
 * agy reads hooks from the project's customization root
 * (`<project>/.agents/hooks.json`), so this provider only installs when hooks
 * are project-scoped (PIXEL_KAISHA_HOOKS_PROJECT_DIR); without it, install
 * refuses instead of guessing a user-level location.
 *
 * The file maps hook NAMES to their event lists; ours is `pixel-kaisha`, so
 * install/uninstall only ever touch that one key.
 */

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
  AGY_HOOK_EVENTS,
  AGY_HOOK_NAME,
  AGY_HOOK_SCRIPT_NAME,
  AGY_HOOK_TIMEOUT_SEC,
  AGY_MATCHER_EVENTS,
} from './constants.js';

export function agyHooksFilePath(): string | undefined {
  const projectDir = hooksProjectDir();
  return projectDir ? path.join(projectDir, '.agents', 'hooks.json') : undefined;
}

/** The command agy runs for `event` (absolute path: agy runs hooks with the
 *  hooks.json folder as working directory). The event name is passed too, as
 *  a fallback should a payload ever lack it. */
export function agyHookCommand(event: string): string {
  return `node "${bundledScriptPath(AGY_HOOK_SCRIPT_NAME)}" ${event}`;
}

function requireFile(file: string | undefined): string {
  if (!file) {
    throw new Error(
      'agy hooks are project-scoped: set PIXEL_KAISHA_HOOKS_PROJECT_DIR to the project folder',
    );
  }
  return file;
}

export function installAgyHooks(file = agyHooksFilePath()): void {
  const target = requireFile(file);
  const settings = readJsonObject(target) ?? {};
  backupOnce(target);
  const entry: Record<string, unknown> = {};
  for (const event of AGY_HOOK_EVENTS) {
    const handler = {
      type: 'command',
      command: agyHookCommand(event),
      timeout: AGY_HOOK_TIMEOUT_SEC,
    };
    entry[event] = AGY_MATCHER_EVENTS.has(event) ? [{ matcher: '*', hooks: [handler] }] : [handler];
  }
  writeJsonAtomic(target, { ...settings, [AGY_HOOK_NAME]: entry });
}

export function uninstallAgyHooks(file = agyHooksFilePath()): void {
  if (!file) return;
  const settings = readJsonObject(file);
  if (settings === null) return;
  const rest = { ...settings };
  delete rest[AGY_HOOK_NAME];
  finishUninstall(file, rest, Object.keys(rest).length === 0);
}

export function agyHooksInstalled(file = agyHooksFilePath()): boolean {
  if (!file) return false;
  try {
    const settings = readJsonObject(file);
    return !!settings && typeof settings[AGY_HOOK_NAME] === 'object';
  } catch {
    return false;
  }
}
