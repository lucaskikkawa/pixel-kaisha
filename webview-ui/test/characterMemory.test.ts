import { describe, expect, it } from 'vitest';

import type { CharacterProfile } from '../../core/src/characterProfiles.js';
import { CastStore } from '../src/characters/cast.js';
import {
  CHARACTER_MEMORY_WARNINGS,
  normalizeMemoryPathInput,
  requestCharacterMemory,
  requestCharacterMemoryFromSaved,
} from '../src/characters/memory.js';

const profile = (id: string, memoryPath?: string): CharacterProfile =>
  ({
    id,
    name: id,
    body: 'flat',
    v: 35,
    ...(memoryPath ? { memoryPath } : {}),
  }) as CharacterProfile;

describe('character memory UI helpers', () => {
  it('keeps absolute and home-relative paths and drops blank or relative input', () => {
    expect(normalizeMemoryPathInput('  ~/notes/CLAUDE.md ')).toBe('~/notes/CLAUDE.md');
    expect(normalizeMemoryPathInput('/work/AGENTS.md')).toBe('/work/AGENTS.md');
    expect(normalizeMemoryPathInput('AGENTS.md')).toBeUndefined();
    expect(normalizeMemoryPathInput('  ')).toBeUndefined();
  });

  it('requests the saved path by profile id and includes an unsaved draft path when needed', () => {
    expect(requestCharacterMemory('profile-1', '~/notes/a.md', '~/notes/a.md')).toEqual({
      type: 'requestCharacterMemory',
      profileId: 'profile-1',
    });
    expect(requestCharacterMemory('profile-1', '~/notes/draft.md', '~/notes/a.md')).toEqual({
      type: 'requestCharacterMemory',
      profileId: 'profile-1',
      path: '~/notes/draft.md',
    });
  });

  it('maps missing and empty paths to readable warnings', () => {
    expect(CHARACTER_MEMORY_WARNINGS['not-found']).toMatch(/not found/i);
    expect(CHARACTER_MEMORY_WARNINGS['no-path']).toMatch(/path/i);
    expect(CHARACTER_MEMORY_WARNINGS['invalid-path']).toBeTruthy();
  });

  it('Show memory sends an unsaved field path, compared with the saved list, not the draft', () => {
    const store = new CastStore({ save: () => {} });
    store.receiveProfiles([profile('suit', '~/notes/a.md')]);
    // what CharacterMemory's updatePath does: the draft takes the field's value
    store.update((draft) => {
      draft.memoryPath = '/tmp/missing.md';
    });
    const { profiles, draft } = store.getState();
    expect(draft?.[0].memoryPath).toBe('/tmp/missing.md');
    expect(profiles[0].memoryPath).toBe('~/notes/a.md');
    // comparing with the draft (the old bug) drops the path
    expect(requestCharacterMemory('suit', '/tmp/missing.md', draft?.[0].memoryPath)).toEqual({
      type: 'requestCharacterMemory',
      profileId: 'suit',
    });
    expect(requestCharacterMemoryFromSaved('suit', '/tmp/missing.md', profiles)).toEqual({
      type: 'requestCharacterMemory',
      profileId: 'suit',
      path: '/tmp/missing.md',
    });
  });

  it('Show memory omits path while the field still holds the saved value', () => {
    const store = new CastStore({ save: () => {} });
    store.receiveProfiles([profile('suit', '~/notes/a.md')]);
    store.update((draft) => {
      draft.memoryPath = '~/notes/a.md';
    });
    expect(
      requestCharacterMemoryFromSaved('suit', '~/notes/a.md', store.getState().profiles),
    ).toEqual({ type: 'requestCharacterMemory', profileId: 'suit' });
    // after Save the new path is the saved one, so it is no longer sent
    store.update((draft) => {
      draft.memoryPath = '/tmp/new.md';
    });
    store.save();
    expect(
      requestCharacterMemoryFromSaved('suit', '/tmp/new.md', store.getState().profiles),
    ).toEqual({ type: 'requestCharacterMemory', profileId: 'suit' });
  });
});
