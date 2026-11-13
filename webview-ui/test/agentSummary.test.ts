/**
 * Pixel Kaisha F2.1: the speech/action balloons.
 *
 * The office keeps each agent's balloon text exactly as the B2.1 server sent it
 * (`agentSummary`, `agentCreated.speech/action`, `existingAgents.summaries`;
 * docs/kaisha/protocol-summary.md) and the balloon draws only the rows that
 * have text: a hooks-only agent (agy, Codex) never speaks, so it gets just its
 * action, not an empty speech row.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';

import { SummaryBalloon } from '../src/office/components/SummaryBalloon.js';
import {
  applySummarySnapshot,
  balloonLines,
  readAgentSummary,
} from '../src/office/engine/agentSummary.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { MOCK_SUMMARY_AGENTS, mockSummaryUpdates } from '../src/office/summaryFixture.js';

/** The server's 80-code-point cut, `…` included. */
const CUT_SPEECH = `${'a'.repeat(79)}…`;

function balloonHtml(
  lines: NonNullable<ReturnType<typeof balloonLines>>,
  short = false,
  expanded = true,
): string {
  return renderToStaticMarkup(
    createElement(SummaryBalloon, { lines, short, expanded, agentId: 1 }),
  );
}

describe('readAgentSummary', () => {
  test('keeps speech and action exactly as sent', () => {
    assert.deepEqual(
      readAgentSummary({ speech: 'Fix the login test', action: 'Reading auth.ts' }),
      {
        speech: 'Fix the login test',
        action: 'Reading auth.ts',
      },
    );
  });

  test('an already-cut long text is kept as it came, never re-cut', () => {
    assert.equal(readAgentSummary({ speech: CUT_SPEECH, action: null })?.speech, CUT_SPEECH);
  });

  test('speech "" and action null = no summary', () => {
    assert.equal(readAgentSummary({ speech: '', action: null }), null);
  });

  test('missing or ill-typed values do not throw and read as empty', () => {
    assert.equal(readAgentSummary(undefined), null);
    assert.equal(readAgentSummary(null), null);
    assert.equal(readAgentSummary({}), null);
    assert.equal(readAgentSummary({ speech: 3, action: {} }), null);
    assert.deepEqual(readAgentSummary({ action: 'Running tests' }), {
      speech: '',
      action: 'Running tests',
    });
    assert.deepEqual(readAgentSummary({ speech: 'Hi' }), { speech: 'Hi', action: null });
  });
});

describe('balloonLines', () => {
  test('a hooks-only agent (no speech) shows only its action', () => {
    assert.deepEqual(balloonLines({ speech: '', action: 'Running npm test' }), {
      speech: null,
      action: 'Running npm test',
    });
  });

  test('no action shows only the speech', () => {
    assert.deepEqual(balloonLines({ speech: 'Done.', action: null }), {
      speech: 'Done.',
      action: null,
    });
  });

  test('nothing to show = no balloon', () => {
    assert.equal(balloonLines(null), null);
    assert.equal(balloonLines({ speech: '   ', action: null }), null);
  });
});

describe('OfficeState summaries', () => {
  test('agentSummary sets the state; a new snapshot replaces it whole', () => {
    const os = new OfficeState();
    os.setAgentSummary(3, { speech: 'Fix the failing login test', action: 'Reading auth.ts' });
    assert.deepEqual(os.getAgentSummary(3), {
      speech: 'Fix the failing login test',
      action: 'Reading auth.ts',
    });
    os.setAgentSummary(3, { speech: 'Fix the failing login test', action: 'Editing auth.ts' });
    assert.equal(os.getAgentSummary(3)?.action, 'Editing auth.ts');
  });

  test('action null clears the action, the speech stays', () => {
    const os = new OfficeState();
    os.setAgentSummary(3, { speech: 'Tests', action: 'Running tests' });
    os.setAgentSummary(3, { speech: 'Tests', action: null });
    assert.deepEqual(os.getAgentSummary(3), { speech: 'Tests', action: null });
  });

  test('speech "" hides the speech; both empty clears the summary', () => {
    const os = new OfficeState();
    os.setAgentSummary(3, { speech: 'Hello', action: 'Reading a.ts' });
    os.setAgentSummary(3, { speech: '', action: 'Reading a.ts' });
    assert.deepEqual(balloonLines(os.getAgentSummary(3)), { speech: null, action: 'Reading a.ts' });
    os.setAgentSummary(3, { speech: '', action: null });
    assert.equal(os.getAgentSummary(3), null);
  });

  test('closing the agent forgets its summary', () => {
    const os = new OfficeState();
    os.addAgent(3);
    os.setAgentSummary(3, { speech: 'Bye', action: null });
    os.removeAgent(3);
    assert.equal(os.getAgentSummary(3), null);
  });

  test('agentCreated speech/action (the handler passes them through)', () => {
    const os = new OfficeState();
    os.addAgent(7);
    os.setAgentSummary(7, { speech: '', action: 'Editing calc.py' });
    assert.deepEqual(balloonLines(os.getAgentSummary(7)), {
      speech: null,
      action: 'Editing calc.py',
    });
  });
});

describe('existingAgents.summaries snapshot', () => {
  test('listed agents take their entry; one without an entry has none', () => {
    const os = new OfficeState();
    os.setAgentSummary(2, { speech: 'stale', action: 'stale' });
    applySummarySnapshot(os, [1, 2], { '1': { speech: 'Hi', action: 'Reading a.ts' } });
    assert.deepEqual(os.getAgentSummary(1), { speech: 'Hi', action: 'Reading a.ts' });
    assert.equal(os.getAgentSummary(2), null);
  });

  test('works before the characters exist (restore buffered until layoutLoaded)', () => {
    const os = new OfficeState();
    applySummarySnapshot(os, [5], { '5': { action: 'Running tests' } });
    assert.equal(os.characters.has(5), false);
    assert.equal(os.getAgentSummary(5)?.action, 'Running tests');
  });

  test('an older server (no summaries field) leaves the state alone', () => {
    const os = new OfficeState();
    os.setAgentSummary(1, { speech: 'Keep', action: null });
    applySummarySnapshot(os, [1], undefined);
    assert.equal(os.getAgentSummary(1)?.speech, 'Keep');
  });

  test('malformed entries do not throw', () => {
    const os = new OfficeState();
    applySummarySnapshot(os, [1, 2], {
      '1': null as never,
      '2': { speech: 42, action: false } as never,
    });
    assert.equal(os.getAgentSummary(1), null);
    assert.equal(os.getAgentSummary(2), null);
  });
});

describe('SummaryBalloon', () => {
  test('an action-only agent renders only the action row', () => {
    const html = balloonHtml({ speech: null, action: 'Running npm test' });
    assert.match(html, /data-testid="summary-action"[^>]*>Running npm test</);
    assert.doesNotMatch(html, /summary-speech/);
  });

  test('speech and action render both, full text as the title', () => {
    const html = balloonHtml({ speech: 'Fix it', action: 'Reading auth.ts' });
    assert.match(html, /summary-speech[^>]*>Fix it</);
    assert.match(html, /summary-action[^>]*>Reading auth.ts</);
    assert.match(html, /title="Fix it\nReading auth.ts"/);
  });

  test('a long cut text is shown as it came (CSS ellipsis only, text untouched)', () => {
    const html = balloonHtml({ speech: CUT_SPEECH, action: null }, true);
    assert.ok(html.includes(`>${CUT_SPEECH}<`));
    assert.match(html, /text-ellipsis/);
  });
});

describe('summary mock fixture', () => {
  test('covers speech+action, action-only (Codex/agy) and speech-only agents', () => {
    const kinds = MOCK_SUMMARY_AGENTS.map((a) => {
      const l = balloonLines(readAgentSummary(a));
      return `${l?.speech ? 'S' : '-'}${l?.action ? 'A' : '-'}`;
    });
    assert.deepEqual(kinds, ['SA', '-A', '-A', 'S-']);
    for (const a of MOCK_SUMMARY_AGENTS) {
      assert.ok([...a.speech].length <= 80);
      assert.ok(a.action === null || [...a.action].length <= 60);
    }
  });

  test('its updates are full agentSummary snapshots', () => {
    for (const step of [1, 2]) {
      for (const m of mockSummaryUpdates(step)) {
        assert.equal(m.type, 'agentSummary');
        assert.equal(typeof m.speech, 'string');
        assert.ok(m.action === null || typeof m.action === 'string');
      }
    }
  });
});
