/**
 * A character's default tool (Pixel Kaisha F2.6): the provider its agents launch with,
 * Claude, Codex or agy. Stored on the profile (`defaultTool`, additive: absent or unknown
 * = claude), so it is saved and loaded with the cast like every other profile field.
 *
 * INTEGRATION POINT (B2.4): besides the profile field, each save that changes a
 * character's tool also sends `setCharacterDefaultTool` (see
 * docs/kaisha/protocol-default-tool.md). An older server ignores that message; the field
 * still persists through `saveCharacterProfiles`.
 */

import type { CharacterProfile } from '../../../core/src/characterProfiles.js';
import type { ClientMessage } from '../../../core/src/messages.js';

/** The tools a character can default to, in the picker's order. */
export const DEFAULT_TOOLS = ['claude', 'codex', 'agy'] as const;
export type DefaultTool = (typeof DEFAULT_TOOLS)[number];
/** What a profile without a (valid) tool of its own launches with: the upstream default. */
export const FALLBACK_DEFAULT_TOOL: DefaultTool = 'claude';

export const isDefaultTool = (value: unknown): value is DefaultTool =>
  (DEFAULT_TOOLS as readonly unknown[]).includes(value);

/** The profile's tool: its own when valid, else claude. */
export const defaultToolOf = (profile: CharacterProfile | undefined): DefaultTool =>
  isDefaultTool(profile?.defaultTool) ? profile.defaultTool : FALLBACK_DEFAULT_TOOL;

/** Set the profile's tool; an unknown value leaves it as it is. */
export function setDefaultTool(profile: CharacterProfile, tool: unknown): void {
  if (isDefaultTool(tool)) profile.defaultTool = tool;
}

/** Client → server: a character's default tool was chosen or changed (and saved). */
export interface SetCharacterDefaultTool {
  type: 'setCharacterDefaultTool';
  profileId: string;
  providerId: DefaultTool;
}

/**
 * The messages a save from `before` to `after` sends: one per character (by id) whose tool
 * differs from what it was, a new character only when it isn't claude (absent = claude on
 * both sides, so nothing to say).
 */
export function defaultToolChanges(
  before: readonly CharacterProfile[],
  after: readonly CharacterProfile[],
): SetCharacterDefaultTool[] {
  const was = new Map(before.map((p) => [p.id, defaultToolOf(p)]));
  return after.flatMap((p) => {
    const tool = defaultToolOf(p);
    if (!p.id || (was.get(p.id) ?? FALLBACK_DEFAULT_TOOL) === tool) return [];
    return [{ type: 'setCharacterDefaultTool' as const, profileId: p.id, providerId: tool }];
  });
}

/**
 * Keeps what the server last knew of each character's tool and sends the changes a save
 * makes. `loaded` = a characterProfilesLoaded's list; `saved` = a list being sent.
 */
export function createDefaultToolSync(send: (msg: SetCharacterDefaultTool) => void) {
  let known: readonly CharacterProfile[] = [];
  return {
    loaded(profiles: readonly CharacterProfile[]): void {
      known = profiles;
    },
    saved(profiles: readonly CharacterProfile[]): void {
      for (const msg of defaultToolChanges(known, profiles)) send(msg);
      known = profiles;
    },
  };
}

/** The message as the transport takes it: not in core/asyncapi.yaml until B2.4 registers it. */
export const asClientMessage = (msg: SetCharacterDefaultTool): ClientMessage =>
  msg as unknown as ClientMessage;
