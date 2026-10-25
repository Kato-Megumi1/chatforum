// Multipart headers without filename* may be interpreted as Latin-1 by Busboy.
// Decode only reversible UTF-8 mojibake; never corrupt an already-Unicode name.
export function normalizeUploadName(name: string): string {
  if (/[^\u0000-\u00ff]/.test(name) || !/[\u0080-\u00ff]/.test(name)) return name;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
    return /[^\u0000-\u00ff]/.test(decoded) ? decoded : name;
  } catch { return name; }
}
