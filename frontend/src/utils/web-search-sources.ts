const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, length: number): string => typeof value === 'string' ? value.trim().slice(0, length) : '';

function publicIpv4(parts: number[]) {
  const [a, b, c] = parts;
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
    a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
    !(a === 192 && b === 0 && (c === 0 || c === 2)) && !(a === 192 && b === 88 && c === 99) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113);
}

function publicIpv6(address: string) {
  const halves = address.split('::');
  if (halves.length > 2 || !/^[a-f0-9:]+$/i.test(address)) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || halves.length === 1 && left.length !== 8) return false;
  const words = [...left, ...Array(fill).fill('0'), ...right].map(word => parseInt(word, 16));
  if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return false;
  // WHATWG URL normalizes IPv4-mapped IPv6 to hexadecimal words.
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff)
    return publicIpv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
  // Only globally scoped unicast literals. Exclude documentation and transition
  // address ranges rather than allowing alternate encodings of local destinations.
  return (words[0] & 0xe000) === 0x2000 && words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && (words[1] === 0 || words[1] === 0x0db8));
}

/** Syntactic link validation only; the UI never fetches or resolves these hosts. */
export function publicWebSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  const input = value.trim();
  if (!input || /[\u0000-\u0020\u007f]/u.test(input)) return undefined;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.+$/u, '');
    if (!host || host === 'localhost' || /\.(?:localhost|local|internal|home|lan)$/u.test(host)) return undefined;
    if (host.startsWith('[')) return publicIpv6(host.slice(1, -1)) ? url.href : undefined;
    if (/^[0-9.]+$/u.test(host)) return publicIpv4(host.split('.').map(Number)) ? url.href : undefined;
    if (!host.includes('.') || !/^[a-z0-9.-]+$/u.test(host) || host.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-')))
      return undefined;
    return url.href;
  } catch { return undefined; }
}

export interface WebSearchSourceView {
  title: string;
  url: string;
  host: string;
  snippet: string;
  engine: string;
  retrievedAt: string;
}

export function webSearchSourceView(input: unknown) {
  const metadata = object(input);
  const sources: WebSearchSourceView[] = [];
  const failed = metadata?.enabled === true && metadata.failure === 'SEARCH_UNAVAILABLE';
  const seen = new Set<string>();
  if (metadata?.enabled === true && Array.isArray(metadata.sources)) {
    for (const value of metadata.sources.slice(0, 128)) {
      const source = object(value), url = publicWebSourceUrl(source?.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const parsed = new URL(url), retrievedAt = text(source?.retrievedAt, 40);
      sources.push({ title: text(source?.title, 300) || parsed.hostname, url, host: parsed.hostname,
        snippet: text(source?.snippet, 600), engine: text(source?.engine, 40),
        retrievedAt: /^\d{4}-\d{2}-\d{2}T/u.test(retrievedAt) && Number.isFinite(Date.parse(retrievedAt)) ? new Date(retrievedAt).toISOString() : '',
      });
      if (sources.length === 32) break;
    }
  }
  return { sources, failed, visible: sources.length > 0 || failed };
}
