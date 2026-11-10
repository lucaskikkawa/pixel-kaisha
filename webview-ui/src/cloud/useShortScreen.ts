import { useSyncExternalStore } from 'react';

/** A cover-screen-sized viewport (Z Flip 6 cover ≈ 360×374 CSS px). */
export const SHORT_SCREEN_QUERY = '(max-height: 480px)';

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(SHORT_SCREEN_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

function get(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(SHORT_SCREEN_QUERY).matches;
}

export function useShortScreen(): boolean {
  return useSyncExternalStore(subscribe, get, () => false);
}
