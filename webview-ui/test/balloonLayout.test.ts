/**
 * Pixel Kaisha F2.1: balloon placement. A speech/action balloon never covers
 * a character (its own or a colleague's), a label, a control or another
 * balloon, and stays inside the office; with no room it is reported unclear
 * (the overlay then hides it unless its agent is in focus).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import type { BalloonRequest, Rect } from '../src/office/engine/balloonLayout.js';
import { placeBalloons, rectsOverlap } from '../src/office/engine/balloonLayout.js';

const OPTS = { bounds: { width: 400, height: 300 }, maxLiftPx: 40, stepPx: 4, marginPx: 2 };

function req(id: number, centerX: number, bottom: number, width = 80, height = 20): BalloonRequest {
  return { id, centerX, bottom, width, height };
}

function rectOf(p: { left: number; top: number }, r: BalloonRequest): Rect {
  return { left: p.left, top: p.top, right: p.left + r.width, bottom: p.top + r.height };
}

describe('placeBalloons', () => {
  test('a balloon with room sits at its natural place, over the head', () => {
    const r = req(1, 200, 150);
    const p = placeBalloons([r], [], OPTS).get(1);
    assert.deepEqual(p, { dx: 0, lift: 0, left: 160, top: 130, clear: true });
  });

  test('it rises or moves aside to clear a colleague, never covering them', () => {
    const r = req(1, 200, 150);
    const colleague: Rect = { left: 150, top: 120, right: 250, bottom: 150 };
    const p = placeBalloons([r], [colleague], OPTS).get(1)!;
    assert.equal(p.clear, true);
    assert.equal(rectsOverlap(rectOf(p, r), colleague), false);
  });

  test('two balloons never overlap; the first in line keeps its place', () => {
    const a = req(1, 200, 150);
    const b = req(2, 210, 150);
    const placed = placeBalloons([a, b], [], OPTS);
    const pa = placed.get(1)!;
    const pb = placed.get(2)!;
    assert.equal(pa.lift, 0);
    assert.equal(pa.dx, 0);
    assert.equal(pb.clear, true);
    assert.equal(rectsOverlap(rectOf(pa, a), rectOf(pb, b)), false);
  });

  test('stays inside the office: a balloon near the edge is nudged in', () => {
    const r = req(1, 20, 150);
    const p = placeBalloons([r], [], OPTS).get(1)!;
    assert.equal(p.clear, true);
    assert.ok(p.left >= OPTS.marginPx);
  });

  test('no room anywhere (a control covers the spot) = not clear', () => {
    const r = req(1, 200, 150);
    const control: Rect = { left: 0, top: 0, right: 400, bottom: 160 };
    const p = placeBalloons([r], [control], OPTS).get(1)!;
    assert.equal(p.clear, false);
  });

  test('an unclear balloon does not block the ones after it', () => {
    const a = req(1, 200, 150);
    const b = req(2, 200, 290, 80, 20);
    const control: Rect = { left: 0, top: 0, right: 400, bottom: 160 };
    const placed = placeBalloons([a, b], [control], OPTS);
    assert.equal(placed.get(1)!.clear, false);
    assert.deepEqual(placed.get(2), { dx: 0, lift: 0, left: 160, top: 270, clear: true });
  });

  test("last frame's spot is kept while the natural one is still blocked", () => {
    const r: BalloonRequest = { ...req(1, 200, 150), prefer: { dx: 20, lift: 40 } };
    const colleague: Rect = { left: 150, top: 120, right: 250, bottom: 150 };
    const p = placeBalloons([r], [colleague], OPTS).get(1)!;
    assert.deepEqual([p.dx, p.lift], [20, 40]);
  });
});
