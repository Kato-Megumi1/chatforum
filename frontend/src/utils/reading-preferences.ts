export const READING_FONT_OPTIONS = [
  { value: 'standard', label: '标准' },
  { value: 'large', label: '大字' },
  { value: 'larger', label: '更大' },
] as const;
export type ReadingFont = typeof READING_FONT_OPTIONS[number]['value'];
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const validFont = (value: unknown): value is ReadingFont => READING_FONT_OPTIONS.some(option => option.value === value);
const preferenceKey = (userId: unknown) => typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0
  ? 'chatforum-reading-font-v1:' + userId : undefined;

function browserStorage(): PreferenceStorage | undefined {
  // Accessing localStorage itself may throw in privacy-restricted contexts.
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function readReadingFont(userId: unknown, storage?: PreferenceStorage): ReadingFont {
  const key = preferenceKey(userId);
  if (!key) return 'standard';
  try {
    const value = (storage || browserStorage())?.getItem(key);
    return validFont(value) ? value : 'standard';
  } catch { return 'standard'; }
}

export function saveReadingFont(userId: unknown, value: unknown, storage?: PreferenceStorage): boolean {
  const key = preferenceKey(userId);
  if (!key || !validFont(value)) return false;
  try {
    const target = storage || browserStorage();
    if (!target) return false;
    // Reset affects only this account's single local display preference.
    if (value === 'standard') target.removeItem(key);
    else target.setItem(key, value);
    return true;
  } catch { return false; }
}

export function readingFontStyle(font: ReadingFont): Record<string, string> {
  if (font === 'large') return { '--reading-body-size': '17px', '--reading-comment-size': '16px' };
  if (font === 'larger') return { '--reading-body-size': '19px', '--reading-comment-size': '18px' };
  return {}; // Do not override the established standard typography/layout.
}
