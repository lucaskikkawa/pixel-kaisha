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

  test('flips a balloon right when its character is at or beyond the left edge', () => {
    const r = req(1, -10, 150, 98, 24);
    const p = placeBalloons([r], [], OPTS).get(1)!;
    assert.equal(p.clear, true);
    assert.ok(p.left >= OPTS.marginPx);
    assert.ok(p.left + r.width <= OPTS.bounds.width - OPTS.marginPx);
    assert.ok(p.dx > r.width / 2);
  });

  test('flips a balloon left when its character is at the right edge', () => {
    const r = req(1, 410, 150, 98, 24);
    const p = placeBalloons([r], [], OPTS).get(1)!;
    assert.equal(p.clear, true);
    assert.ok(p.left >= OPTS.marginPx);
    assert.ok(p.left + r.width <= OPTS.bounds.width - OPTS.marginPx);
    assert.ok(p.dx < -r.width / 2);
  });

  test('lifts a balloon enough to fit below the viewport edge', () => {
    const r = req(1, 200, 303, 98, 24);
    const p = placeBalloons([r], [], { ...OPTS, bounds: { width: 400, height: 300 } }).get(1)!;
    assert.equal(p.clear, true);
    assert.ok(p.top + r.height <= 300 - OPTS.marginPx);
  });

  test('keeps a short-screen focused balloon above bottom chrome and the viewport edge', () => {
    const r = req(201, 84, 377, 132, 41);
    const bar: Rect = { left: 0, top: 322, right: 360, bottom: 430 };
    const player: Rect = { left: 118.75, top: 266, right: 241.25, bottom: 304 };
    const p = placeBalloons([r], [bar, player], {
      bounds: { width: 360, height: 374 },
      safeBottom: 322,
      maxLiftPx: 40,
      stepPx: 4,
      marginPx: 8,
    }).get(201)!;
    const rect = rectOf(p, r);
    assert.equal(p.clear, true);
    assert.ok(rect.bottom <= 322 - 8);
    assert.ok(rect.bottom <= 374 - 8);
    assert.ok(rect.left >= 8 && rect.right <= 360 - 8);
    assert.equal(rectsOverlap(rect, bar), false);
    assert.equal(rectsOverlap(rect, player), false);
  });

  test('clamps an unclear focused balloon into safe bounds', () => {
    const r = req(202, 84, 377, 132, 41);
    const wall: Rect = { left: 0, top: 0, right: 360, bottom: 430 };
    const p = placeBalloons([r], [wall], {
      bounds: { width: 360, height: 374 },
      safeBottom: 322,
      maxLiftPx: 40,
      stepPx: 4,
      marginPx: 8,
    }).get(202)!;
    const rect = rectOf(p, r);
    assert.equal(p.clear, false);
    assert.ok(rect.left >= 8 && rect.right <= 352);
    assert.ok(rect.top >= 8 && rect.bottom <= 314);
  });

  test('moves a balloon down when its natural position crosses the top edge', () => {
    const r = req(1, 200, 10, 98, 24);
    const p = placeBalloons([r], [], OPTS).get(1)!;
    assert.equal(p.clear, true);
    assert.ok(p.top >= OPTS.marginPx);
    assert.ok(p.lift < 0);
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
