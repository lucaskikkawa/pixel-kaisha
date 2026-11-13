import assert from 'node:assert/strict';

import { test } from 'vitest';

import { createCharacter, updateCharacter } from '../src/office/engine/characters.js';
import { isAgentRoom, setAgentRoomMessage } from '../src/office/engine/roomProtocol.js';
import { CharacterState } from '../src/office/types.js';

test('accepts only the three protocol rooms', () => {
  for (const room of ['work', 'meeting', 'rest']) assert.equal(isAgentRoom(room), true);
  assert.equal(isAgentRoom('kitchen'), false);
  assert.equal(isAgentRoom(undefined), false);
});

test('meeting controls send one setAgentRoom message for one agent', () => {
  assert.deepEqual(setAgentRoomMessage(42, 'meeting'), {
    type: 'setAgentRoom',
    id: 42,
    room: 'meeting',
  });
});

test('activity animation keeps a meeting character in its server room', () => {
  const character = createCharacter(42, 0, null, null);
  character.room = 'meeting';
  character.state = CharacterState.IDLE;
  character.isActive = true;

  updateCharacter(character, 0.1, [], new Map(), [], new Set());

  assert.equal(character.room, 'meeting');
  assert.equal(character.state, CharacterState.TYPE);
});
