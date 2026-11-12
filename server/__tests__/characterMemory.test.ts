import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CharacterProfile } from '../../core/src/characterProfiles.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  buildCharacterMemory,
  readCharacterMemory,
  resolveMemoryPath,
} from '../src/characterMemory.js';
import {
  getCharacterProfiles,
  handleCharacterProfilesClientMessage,
} from '../src/characterProfilesPersistence.js';
import { MEMORY_READ_MAX_BYTES } from '../src/constants.js';

/**
 * Pixel Kaisha B2.4: a character's memory path is stored on its profile and survives a
 * restart; its content is read on request, read only, and a missing path is a warning.
 * Every fixture lives in a temp dir of this suite's own (also the fake home), removed after.
 */
describe('character memory', () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-memory-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (rel: string, content: string | Buffer) => {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  describe('the path on the profile', () => {
    const save = (profiles: unknown) => {
      const answers: Array<Record<string, unknown>> = [];
      handleCharacterProfilesClientMessage(
        { profiles, saveId: 's' },
        {
          broadcast: (m) => answers.push(m),
          reply: (m) => answers.push(m),
          store: new AgentStateStore(),
          sharedRefsChanged: () => {},
        },
      );
      return answers;
    };
    /** A restart: the cache is keyed by $HOME, so leaving and coming back re-reads the file. */
    const restart = () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-memory-away-'));
      process.env.HOME = elsewhere;
      getCharacterProfiles();
      process.env.HOME = tmp;
      fs.rmSync(elsewhere, { recursive: true, force: true });
    };

    it('is saved and restored per character; absent stays absent; "" is dropped', () => {
      const answers = save([
        { id: 'a', body: 'flat', v: 35, memoryPath: '/repo-a/CLAUDE.md' },
        { id: 'b', body: 'bust', v: 35, memoryPath: '~/.claude/projects/b/memory' },
        { id: 'c', body: 'flat', v: 35 },
        { id: 'd', body: 'flat', v: 35, memoryPath: '' },
      ]);
      expect(answers).toHaveLength(1);
      expect(answers[0].saveId).toBe('s');

      const onDisk = JSON.parse(
        fs.readFileSync(path.join(tmp, '.pixel-agents', 'characters.json'), 'utf-8'),
      ) as CharacterProfile[];
      expect(onDisk.find((p) => p.id === 'd')).not.toHaveProperty('memoryPath');

      restart();
      const byId = new Map(getCharacterProfiles().map((p) => [p.id, p]));
      expect(byId.get('a')?.memoryPath).toBe('/repo-a/CLAUDE.md');
      expect(byId.get('b')?.memoryPath).toBe('~/.claude/projects/b/memory');
      expect(byId.get('c')).not.toHaveProperty('memoryPath');
      expect(byId.get('d')).not.toHaveProperty('memoryPath');
    });

    it('an invalid path is dropped on save; the profile is still saved', () => {
      save([{ id: 'a', body: 'flat', v: 35, memoryPath: 7 }]);
      restart();
      expect(getCharacterProfiles()).toEqual([{ id: 'a', body: 'flat', v: 35 }]);
    });
  });

  describe('readCharacterMemory', () => {
    it('reads an existing file', async () => {
      const file = write('repo/CLAUDE.md', '# Memory\nuse tabs\n');
      expect(await readCharacterMemory(file, tmp)).toEqual({
        path: file,
        content: '# Memory\nuse tabs\n',
      });
    });

    it('a missing path is not-found, without content and without throwing', async () => {
      const missing = path.join(tmp, 'nope', 'AGENTS.md');
      const read = await readCharacterMemory(missing, tmp);
      expect(read).toEqual({ path: missing, warning: 'not-found' });
      expect(read).not.toHaveProperty('content');
      // a parent that is a file is not-found too
      const file = write('plain.md', 'x');
      expect((await readCharacterMemory(path.join(file, 'GEMINI.md'), tmp)).warning).toBe(
        'not-found',
      );
    });

    it('a folder: its .md files joined under headers, listed in files', async () => {
      const dir = path.join(tmp, '.claude', 'projects', 'p', 'memory');
      write('.claude/projects/p/memory/b.md', 'second');
      write('.claude/projects/p/memory/a.md', 'first');
      write('.claude/projects/p/memory/.hidden.md', 'hidden');
      write('.claude/projects/p/memory/image.png', 'png');
      write('.claude/projects/p/memory/sub/c.md', 'nested');
      const read = await readCharacterMemory(dir, tmp);
      expect(read).toEqual({
        path: dir,
        content: '--- a.md ---\n\nfirst\n\n--- b.md ---\n\nsecond',
        files: ['a.md', 'b.md'],
      });
    });

    it('an empty folder is content "" with no warning', async () => {
      const dir = path.join(tmp, 'empty');
      fs.mkdirSync(dir);
      expect(await readCharacterMemory(dir, tmp)).toEqual({ path: dir, content: '', files: [] });
    });

    it('does not follow a symlink inside a folder', async () => {
      const outside = write('outside/secret.md', 'secret');
      const dir = path.join(tmp, 'mem');
      write('mem/own.md', 'own');
      fs.symlinkSync(outside, path.join(dir, 'link.md'));
      const read = await readCharacterMemory(dir, tmp);
      expect(read.files).toEqual(['own.md']);
      expect(read.content).not.toContain('secret');
    });

    it('a file over 256 KiB is too-large, without content', async () => {
      const file = write('big/CLAUDE.md', 'x'.repeat(MEMORY_READ_MAX_BYTES + 1));
      expect(await readCharacterMemory(file, tmp)).toEqual({ path: file, warning: 'too-large' });
      const exact = write('big/AGENTS.md', 'y'.repeat(MEMORY_READ_MAX_BYTES));
      expect((await readCharacterMemory(exact, tmp)).content).toHaveLength(MEMORY_READ_MAX_BYTES);
    });

    it('a folder past the cap sends the files that fit, with too-large', async () => {
      write('mem/a.md', 'small');
      write('mem/b.md', 'z'.repeat(MEMORY_READ_MAX_BYTES));
      const read = await readCharacterMemory(path.join(tmp, 'mem'), tmp);
      expect(read.files).toEqual(['a.md']);
      expect(read.content).toBe('--- a.md ---\n\nsmall');
      expect(read.warning).toBe('too-large');
    });

    it('a binary file is unreadable', async () => {
      const file = write('bin.md', Buffer.from([0, 1, 2, 3]));
      expect(await readCharacterMemory(file, tmp)).toEqual({ path: file, warning: 'unreadable' });
    });

    it('expands ~ to the home directory', async () => {
      write('CLAUDE.md', 'home memory');
      expect(resolveMemoryPath('~/CLAUDE.md', tmp)).toBe(path.join(tmp, 'CLAUDE.md'));
      expect(resolveMemoryPath('~', tmp)).toBe(tmp);
      expect(await readCharacterMemory('~/CLAUDE.md', tmp)).toEqual({
        path: path.join(tmp, 'CLAUDE.md'),
        content: 'home memory',
      });
    });

    it('a relative or ~user path is invalid-path', async () => {
      expect(await readCharacterMemory('CLAUDE.md', tmp)).toEqual({
        path: '',
        warning: 'invalid-path',
      });
      expect((await readCharacterMemory('~root/x', tmp)).warning).toBe('invalid-path');
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'an unreadable file is unreadable',
      async () => {
        const file = write('locked.md', 'x');
        fs.chmodSync(file, 0o000);
        expect(await readCharacterMemory(file, tmp)).toEqual({ path: file, warning: 'unreadable' });
      },
    );

    it('never writes: content and mtime unchanged, nothing created', async () => {
      const file = write('repo/CLAUDE.md', 'keep me');
      const dir = path.join(tmp, 'mem');
      write('mem/a.md', 'a');
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(file, past, past);
      fs.utimesSync(path.join(dir, 'a.md'), past, past);
      const before = [fs.statSync(file).mtimeMs, fs.statSync(path.join(dir, 'a.md')).mtimeMs];
      const listing = fs.readdirSync(dir);

      await readCharacterMemory(file, tmp);
      await readCharacterMemory(dir, tmp);
      await readCharacterMemory(path.join(tmp, 'missing', 'CLAUDE.md'), tmp);

      expect(fs.readFileSync(file, 'utf-8')).toBe('keep me');
      expect([fs.statSync(file).mtimeMs, fs.statSync(path.join(dir, 'a.md')).mtimeMs]).toEqual(
        before,
      );
      expect(fs.readdirSync(dir)).toEqual(listing);
      expect(fs.existsSync(path.join(tmp, 'missing'))).toBe(false);
    });
  });

  describe('buildCharacterMemory', () => {
    const profiles: CharacterProfile[] = [
      { id: 'a', body: 'flat', memoryPath: '~/CLAUDE.md' },
      { id: 'b', body: 'bust' },
    ];

    it("reads the profile's stored path", async () => {
      write('CLAUDE.md', 'stored');
      expect(await buildCharacterMemory({ profileId: 'a' }, profiles, tmp)).toEqual({
        type: 'characterMemory',
        profileId: 'a',
        path: path.join(tmp, 'CLAUDE.md'),
        content: 'stored',
      });
    });

    it('an unknown profile or one without a path is a warning', async () => {
      expect(await buildCharacterMemory({ profileId: 'zz' }, profiles, tmp)).toEqual({
        type: 'characterMemory',
        profileId: 'zz',
        path: '',
        warning: 'unknown-profile',
      });
      expect(await buildCharacterMemory({ profileId: 3 }, profiles, tmp)).toMatchObject({
        profileId: '',
        warning: 'unknown-profile',
      });
      expect(await buildCharacterMemory({ profileId: 'b' }, profiles, tmp)).toEqual({
        type: 'characterMemory',
        profileId: 'b',
        path: '',
        warning: 'no-path',
      });
    });

    it('a path override wins, even for a profile not saved yet', async () => {
      const file = write('draft/AGENTS.md', 'draft');
      expect(await buildCharacterMemory({ profileId: 'b', path: file }, profiles, tmp)).toEqual({
        type: 'characterMemory',
        profileId: 'b',
        path: file,
        content: 'draft',
      });
      expect(
        (await buildCharacterMemory({ profileId: 'new', path: file }, profiles, tmp)).content,
      ).toBe('draft');
      expect((await buildCharacterMemory({ profileId: 'a', path: 5 }, profiles, tmp)).warning).toBe(
        'invalid-path',
      );
    });
  });
});
