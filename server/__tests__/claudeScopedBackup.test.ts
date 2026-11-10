import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { installHooks, uninstallHooks } =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');
const { SETTINGS_BACKUP_SUFFIX } = await import('../src/providers/hook/claude/constants.js');
const { ABSENT_MARKER } = await import('../src/providers/hook/shared/jsonSettingsFile.js');
const { HOOKS_PROJECT_DIR_ENV, HOOKS_PROJECT_DIR_ALIAS_ENV, hooksProjectDir } =
  await import('../src/providers/hook/shared/hooksScope.js');

/**
 * Pixel Kaisha v0.1.1 (QA failure B): a project-scoped Claude install records
 * the pre-install state in .claude/settings.json.pixel-agents.backup (a copy,
 * or a marker that the file was absent) and uninstall puts it back.
 */
describe('Claude project-scoped backup/restore', () => {
  let project: string;
  let settings: string;
  let backup: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxk-claude-scope-'));
    project = path.join(tmpBase, 'sandbox');
    fs.mkdirSync(project);
    settings = path.join(project, '.claude', 'settings.json');
    backup = settings + SETTINGS_BACKUP_SUFFIX;
    process.env[HOOKS_PROJECT_DIR_ENV] = project;
  });

  afterEach(() => {
    delete process.env[HOOKS_PROJECT_DIR_ENV];
    delete process.env[HOOKS_PROJECT_DIR_ALIAS_ENV];
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('absent original: install writes the marker, uninstall deletes both files', async () => {
    await installHooks();
    expect(fs.existsSync(settings)).toBe(true);
    expect(fs.readFileSync(backup, 'utf8')).toBe(ABSENT_MARKER);
    await uninstallHooks();
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
    // Never touches the user-level file.
    expect(fs.existsSync(path.join(tmpBase, '.claude', 'settings.json'))).toBe(false);
  });

  it('existing original: install copies it, uninstall restores the exact bytes', async () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const original = '{\n    "permissions": {"allow": ["Bash(ls)"]}\n}\n';
    fs.writeFileSync(settings, original);
    await installHooks();
    expect(fs.readFileSync(backup, 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks).toBeTruthy();
    await uninstallHooks();
    expect(fs.readFileSync(settings, 'utf8')).toBe(original);
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('a file holding only our hooks (pre-fix install, no backup) is treated as absent', async () => {
    await installHooks();
    fs.unlinkSync(backup); // the v0.1.0 sandbox state
    await installHooks(); // reinstall (e.g. server restart): idempotent, no write
    await uninstallHooks();
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('user content added after install is kept on uninstall', async () => {
    await installHooks();
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    s.permissions = { allow: ['Bash(ls)'] };
    fs.writeFileSync(settings, JSON.stringify(s));
    await uninstallHooks();
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls)'] },
    });
  });

  it('KAISHA_HOOKS_PROJECT_DIR is accepted as an alias; "user" means user-level', () => {
    delete process.env[HOOKS_PROJECT_DIR_ENV];
    process.env[HOOKS_PROJECT_DIR_ALIAS_ENV] = project;
    expect(hooksProjectDir()).toBe(path.resolve(project));
    process.env[HOOKS_PROJECT_DIR_ALIAS_ENV] = 'user';
    expect(hooksProjectDir()).toBeUndefined();
  });
});
