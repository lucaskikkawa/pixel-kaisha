/** Longest title a short-screen chip shows (two wrapped lines); the full one
 *  stays in the chip's tooltip / accessible name. */
export const CHIP_TITLE_MAX = 40;

/** Shorten a title for a cramped card (short screen). */
export function shortTitle(title: string, max: number): string {
  return title.length <= max ? title : `${title.slice(0, Math.max(1, max - 1))}…`;
}
