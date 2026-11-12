// webview-ui/src/office/engine/balloonLayout.ts
//
// Pixel Kaisha F2.1: where each speech/action balloon goes so it covers no
// character (its own or a colleague's), no label, no control, no other balloon,
// and stays inside the office. Pure screen-space geometry (CSS px), DOM-free,
// unit-tested; ToolOverlay measures the boxes and draws the result.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A balloon to place: centred on `centerX`, its bottom edge at `bottom` when it can stay put. */
export interface BalloonRequest {
  id: number;
  centerX: number;
  bottom: number;
  width: number;
  height: number;
  /** Offset it had last frame: tried first, so a balloon doesn't hop between spots. */
  prefer?: BalloonOffset;
}

/** How far a balloon moved from its natural place: `lift` up, `dx` sideways (CSS px). */
export interface BalloonOffset {
  dx: number;
  lift: number;
}

export interface BalloonPlacement extends BalloonOffset {
  left: number;
  top: number;
  /** False when no clear spot was found: the caller hides it (or shows it, for the agent in focus). */
  clear: boolean;
}

export interface BalloonLayoutOptions {
  /** The office's size in CSS px: balloons stay inside it. */
  bounds: { width: number; height: number };
  /** How far a balloon may rise above its natural place to find room. */
  maxLiftPx: number;
  /** Rise step. */
  stepPx: number;
  /** Margin kept from the office's edges. */
  marginPx: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Place the balloons in the order given (the caller puts the agent in focus
 * first, then front to back). Each takes the first clear spot: its natural
 * place, else its last frame's offset if still clear, else rising from its natural place in
 * `stepPx` steps up to `maxLiftPx`, at each height trying its centre and then
 * nudges of a quarter and half its width to either side (so it stays over its
 * own character). A spot must be fully inside the office and clear of every
 * obstacle and of the balloons placed before it.
 */
export function placeBalloons(
  requests: BalloonRequest[],
  obstacles: Rect[],
  opts: BalloonLayoutOptions,
): Map<number, BalloonPlacement> {
  const { bounds, maxLiftPx, stepPx, marginPx } = opts;
  const placed: Rect[] = [];
  const result = new Map<number, BalloonPlacement>();

  for (const r of requests) {
    const at = ({ dx, lift }: BalloonOffset): Rect => {
      const left = r.centerX - r.width / 2 + dx;
      const top = r.bottom - r.height - lift;
      return { left, top, right: left + r.width, bottom: top + r.height };
    };
    const fits = (rect: Rect) =>
      rect.left >= marginPx &&
      rect.top >= marginPx &&
      rect.right <= bounds.width - marginPx &&
      rect.bottom <= bounds.height - marginPx &&
      !obstacles.some((o) => rectsOverlap(rect, o)) &&
      !placed.some((p) => rectsOverlap(rect, p));

    // Its natural place first (over its own head), then last frame's spot.
    const candidates: BalloonOffset[] = [{ dx: 0, lift: 0 }];
    if (r.prefer) candidates.push(r.prefer);
    const nudges = [0, -r.width / 4, r.width / 4, -r.width / 2, r.width / 2];
    for (let lift = 0; lift <= maxLiftPx; lift += Math.max(1, stepPx)) {
      for (const dx of nudges) candidates.push({ dx, lift });
    }
    const found = candidates.find((c) => fits(at(c)));
    const offset = found ?? { dx: 0, lift: 0 };
    const rect = at(offset);
    if (found) placed.push(rect);
    result.set(r.id, { ...offset, left: rect.left, top: rect.top, clear: !!found });
  }
  return result;
}
