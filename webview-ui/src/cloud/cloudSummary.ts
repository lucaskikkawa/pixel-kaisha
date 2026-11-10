/** Shorten a title for a cramped card (cover screen). */
export function shortTitle(title: string, max: number): string {
  return title.length <= max ? title : `${title.slice(0, Math.max(1, max - 1))}…`;
}
