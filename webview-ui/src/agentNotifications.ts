export type AgentNoticeState = 'waiting' | 'done' | 'other';
type Permission = 'default' | 'denied' | 'granted';
interface BrowserNotificationConstructor {
  permission: Permission;
  requestPermission(): Promise<Permission>;
  new (title: string, options: { body: string; icon: string }): unknown;
}
function notificationApi(): BrowserNotificationConstructor | undefined {
  return (globalThis as unknown as { Notification?: BrowserNotificationConstructor }).Notification;
}

export function shouldNotify(enabled: boolean, permission: Permission): boolean {
  return enabled && permission === 'granted';
}

export function noticeForTransition(
  previous: AgentNoticeState | undefined,
  next: AgentNoticeState,
): 'waiting' | 'done' | null {
  return next !== 'other' && previous !== next ? next : null;
}

export function notifyAgent(name: string, kind: 'waiting' | 'done'): boolean {
  const api = notificationApi();
  if (!api || !shouldNotify(isBrowserNotificationsEnabled(), api.permission)) return false;
  new api(name, {
    body: kind === 'waiting' ? 'is waiting for input' : 'finished',
    icon: '/icons/icon-192.png',
  });
  return true;
}

const STORAGE_KEY = 'pixelAgentBrowserNotifications';
export function isBrowserNotificationsEnabled(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true';
}
export async function enableBrowserNotifications(enabled: boolean): Promise<boolean> {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, String(enabled));
  if (!enabled) return false;
  const api = notificationApi();
  if (!api) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, 'false');
    return false;
  }
  const permission = api.permission === 'default' ? await api.requestPermission() : api.permission;
  const granted = permission === 'granted';
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, String(granted));
  return granted;
}
