export const CONNECTION_SETTINGS_ENABLED = import.meta.env.DEV;
let stored = '';
// Production trusts deployment configuration only. Never read a browser override,
// including values left behind by earlier releases or edited in developer tools.
if (import.meta.env.DEV) {
  try { stored = localStorage.getItem('chatforum-api-base') || ''; }
  catch { /* Restricted browser storage: keep the configured development default. */ }
}
export const API_BASE = (stored || import.meta.env.VITE_API_BASE_URL || '/api').trim().replace(/\/+$/, '');
export const apiUrl = (route: string) => API_BASE + '/' + route.replace(/^\//, '');
export const publicAsset = (name: string) => import.meta.env.BASE_URL + name.replace(/^\//, '');
export const mediaUrl = (value?: string) => {
  if (!value) return value;
  if (value.startsWith('/uploads/')) {
    return API_BASE.startsWith('https://') || API_BASE.startsWith('http://')
      ? new URL(API_BASE).origin + value : value;
  }
  return /^(https?:\/\/|\/)/.test(value) ? value : undefined;
};
export function normalizeMedia(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeMedia);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) =>
    [key, key === 'avatar' && typeof v === 'string' ? mediaUrl(v) : normalizeMedia(v)]));
  return value;
}
