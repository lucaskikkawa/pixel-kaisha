import { describe, expect, it } from 'vitest';

import {
  CHARACTER_MEMORY_WARNINGS,
  normalizeMemoryPathInput,
  requestCharacterMemory,
} from '../src/characters/memory.js';

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
});
