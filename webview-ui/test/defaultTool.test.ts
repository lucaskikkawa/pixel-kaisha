import { describe, expect, it, vi } from 'vitest';

import { type CharacterProfile, parseCharacterProfiles } from '../../core/src/characterProfiles.js';
import { CastStore } from '../src/characters/cast.js';
import {
  createDefaultToolSync,
  DEFAULT_TOOLS,
  defaultToolChanges,
  defaultToolOf,
  type SetCharacterDefaultTool,
  setDefaultTool,
} from '../src/characters/defaultTool.js';

const profile = (id: string, defaultTool?: unknown): CharacterProfile =>
  ({
    id,
    name: id,
    body: 'flat',
    v: 35,
    ...(defaultTool === undefined ? {} : { defaultTool }),
  }) as CharacterProfile;

/** The app's wiring (castStore.ts + castMessages.ts) over a mocked transport.send. */
function setup(initial: CharacterProfile[]) {
  const send = vi.fn<(msg: { type: string }) => void>();
  const tools = createDefaultToolSync((msg) => send(msg));
  const store = new CastStore({
    save: (profiles, saveId, items) => {
      send({ type: 'saveCharacterProfiles', ...{ profiles, saveId, items } });
      tools.saved(profiles);
    },
  });
  const receive = (profiles: CharacterProfile[]) => {
    const parsed = parseCharacterProfiles(JSON.parse(JSON.stringify(profiles)));
    if (parsed) tools.loaded(parsed);
    store.receiveProfiles(parsed);
  };
  receive(initial);
  const choose = (index: number, tool: unknown) =>
    store.updateAt(index, (draft) => setDefaultTool(draft, tool));
  const toolMessages = () =>
    send.mock.calls
      .map(([m]) => m)
      .filter((m): m is SetCharacterDefaultTool => m.type === 'setCharacterDefaultTool');
  const saved = () => store.getState().profiles.map(defaultToolOf);
  return { store, send, choose, toolMessages, saved, receive };
}

describe('default tool on a profile', () => {
  it('a profile without one (an old profile) defaults to claude', () => {
    expect(defaultToolOf(profile('a'))).toBe('claude');
    expect(defaultToolOf(undefined)).toBe('claude');
  });

  it('an invalid stored value reads as claude and does not break validation', () => {
    for (const bad of ['gpt', '', 42, null, { id: 'codex' }]) {
      const parsed = parseCharacterProfiles([profile('a', bad)]);
      expect(parsed).not.toBeNull();
      expect(defaultToolOf(parsed![0])).toBe('claude');
    }
  });

  it('setting an invalid value is ignored', () => {
    const p = profile('a', 'codex');
    setDefaultTool(p, 'nope');
    setDefaultTool(p, undefined);
    expect(p.defaultTool).toBe('codex');
    for (const tool of DEFAULT_TOOLS) {
      setDefaultTool(p, tool);
      expect(defaultToolOf(p)).toBe(tool);
    }
  });

  it('survives the validator and migration (older format too)', () => {
    const [migrated] = parseCharacterProfiles([{ ...profile('a', 'agy'), v: 33 }])!;
    expect(migrated.defaultTool).toBe('agy');
  });
});

describe('default tool per character', () => {
  it('A=claude, B=codex; changing A leaves B alone', () => {
    const { store, choose, saved } = setup([profile('a'), profile('b')]);
    choose(1, 'codex');
    store.save();
    expect(saved()).toEqual(['claude', 'codex']);
    choose(0, 'agy');
    store.save();
    expect(saved()).toEqual(['agy', 'codex']);
    choose(0, 'claude');
    store.save();
    expect(saved()).toEqual(['claude', 'codex']);
  });

  it('is part of the profile saved with saveCharacterProfiles', () => {
    const { store, send, choose } = setup([profile('a'), profile('b')]);
    choose(1, 'codex');
    store.save();
    const save = send.mock.calls.find(([m]) => m.type === 'saveCharacterProfiles')![0] as {
      profiles: CharacterProfile[];
    };
    expect(save.profiles.map((p) => p.defaultTool)).toEqual([undefined, 'codex']);
  });

  it('stays in the draft until Save, and undo takes it back', () => {
    const { store, choose, toolMessages, saved } = setup([profile('a')]);
    choose(0, 'codex');
    expect(store.getState().dirty).toBe(true);
    expect(saved()).toEqual(['claude']);
    expect(toolMessages()).toEqual([]);
    store.undo();
    expect(store.getState().dirty).toBe(false);
  });

  it('a profile loaded from the server keeps its tool', () => {
    const { saved } = setup([profile('a', 'agy'), profile('b', 'codex'), profile('c')]);
    expect(saved()).toEqual(['agy', 'codex', 'claude']);
  });
});

describe('setCharacterDefaultTool', () => {
  it('a save sends one message per changed character, in the documented shape', () => {
    const { store, choose, toolMessages } = setup([profile('a'), profile('b')]);
    choose(1, 'codex');
    store.save();
    expect(toolMessages()).toEqual([
      { type: 'setCharacterDefaultTool', profileId: 'b', providerId: 'codex' },
    ]);
    // a save that changes something else sends no tool message
    store.updateAt(0, (d) => {
      d.name = 'renamed';
    });
    store.save();
    expect(toolMessages()).toHaveLength(1);
  });

  it('switching back to claude is sent too', () => {
    const { store, choose, toolMessages } = setup([profile('a', 'agy')]);
    choose(0, 'claude');
    store.save();
    expect(toolMessages()).toEqual([
      { type: 'setCharacterDefaultTool', profileId: 'a', providerId: 'claude' },
    ]);
  });

  it('a new character says nothing unless it is not claude', () => {
    expect(defaultToolChanges([profile('a')], [profile('a'), profile('b')])).toEqual([]);
    expect(defaultToolChanges([profile('a')], [profile('a'), profile('b', 'agy')])).toEqual([
      { type: 'setCharacterDefaultTool', profileId: 'b', providerId: 'agy' },
    ]);
  });

  it('a list from the server becomes the base for the next save', () => {
    const { store, choose, toolMessages, receive } = setup([profile('a')]);
    receive([profile('a', 'codex')]); // another office saved it
    choose(0, 'codex');
    store.save();
    expect(toolMessages()).toEqual([]);
  });
});
