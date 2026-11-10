import { CLOUD_MUTED_COLOR, CLOUD_READY_COLOR } from '../constants.js';
import type { CloudStatus } from './cloudStore.js';

/** Label and colour per ghost status. */
export const CLOUD_STATUS_VIEW: Record<CloudStatus, { label: string; color: string }> = {
  active: { label: 'active', color: 'var(--color-status-active)' },
  ready: { label: 'ready ✓', color: CLOUD_READY_COLOR },
  error: { label: 'error', color: 'var(--color-status-error)' },
  unavailable: { label: 'unavailable', color: CLOUD_MUTED_COLOR },
  unknown: { label: '?', color: CLOUD_MUTED_COLOR },
};
