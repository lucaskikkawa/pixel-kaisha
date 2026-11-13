import type { ClientMessage } from '../../../core/src/messages.js';

export function normalizeMemoryPathInput(value: string): string | undefined {
  const path = value.trim();
  if (!path || path.length > 1024 || path.includes('\0')) return undefined;
  return path.startsWith('/') ||
    path === '~' ||
    path.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith('\\\\')
    ? path
    : undefined;
}

export function requestCharacterMemory(
  profileId: string,
  draftPath: string,
  savedPath?: string,
): ClientMessage {
  const message: ClientMessage = { type: 'requestCharacterMemory', profileId };
  if (draftPath.trim() !== (savedPath ?? '')) {
    return { ...message, path: draftPath };
  }
  return message;
}

/**
 * The request for Show memory: the field is compared with the path already SAVED for
 * this profile (the roster's list, not the view's draft, which holds the field's own
 * value), so an unsaved path is sent and read instead of the saved one.
 */
export function requestCharacterMemoryFromSaved(
  profileId: string,
  draftPath: string,
  savedProfiles: readonly { id?: string; memoryPath?: string }[],
): ClientMessage {
  const saved = savedProfiles.find((profile) => profile.id === profileId);
  return requestCharacterMemory(profileId, draftPath, saved?.memoryPath);
}

export const CHARACTER_MEMORY_WARNINGS: Record<string, string> = {
  'not-found': 'Memory path was not found.',
  'not-a-file': 'The path is not a regular file or folder.',
  'too-large': 'Memory is larger than the 256 KiB read limit.',
  unreadable: 'Memory could not be read (or is not UTF-8 text).',
  'no-path': 'Add a memory path first.',
  'invalid-path': 'Use an absolute path or a path starting with ~/.',
  'unknown-profile': 'This character profile is no longer available.',
};
