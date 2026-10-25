import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicAddress } from '../../admin-settings/mail.service';
import type { WebSource } from './web-search.skill';
const ENGINES = ['html.duckduckgo.com', 'www.bing.com'];
function plain(value: string) {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, '')
    .replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));/gi, (full, numeric, name) => {
      if (numeric) { const n = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
        return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''; }
      return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as any)[name.toLowerCase()] || full;
    }).replace(/\s+/g, ' ').trim();
}
export function webSourceUrl(value: string): string | undefined {
  try {
    if (!/^(?:https?:\/\/|\/\/|\/l\/\?)/i.test(value)) return undefined;
    let url = new URL(value.startsWith('//') ? 'https:' + value : value, 'https://html.duckduckgo.com');
    if (url.hostname === 'html.duckduckgo.com' || url.hostname === 'duckduckgo.com') {
      if (url.pathname === '/l/') url = new URL(url.searchParams.get('uddg') || '');
    }
    if (url.hostname === 'www.bing.com' && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u'); if (!encoded?.startsWith('a1')) return undefined;
      url = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port) ||
      !host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host) ||
      (isIP(host) && !publicAddress(host)) || url.href.length > 2048) return undefined;
    return url.href;
  } catch { return undefined; }
}
// Only fixed HTTPS engines, no redirects or result-page fetching. Validated DNS is pinned
// to the same TLS connection. The deadline covers DNS, headers AND the bounded response body.
export async function readSearchHtml(url: URL, outerSignal?: AbortSignal): Promise<string> {
  if (url.protocol !== 'https:' || !ENGINES.includes(url.hostname) || url.port || url.username || url.password) throw new Error('Search host rejected');
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Search timeout')), 8000); timer.unref();
  if (outerSignal?.aborted) abort();
  let cancelDns: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => {
      cancelDns = () => reject(signal.reason); signal.addEventListener('abort', cancelDns, { once: true });
    })]);
    if (cancelDns) signal.removeEventListener('abort', cancelDns);
    signal.throwIfAborted();
    if (!addresses.length || addresses.length > 16 || addresses.some(a => !publicAddress(a.address))) throw new Error('Search DNS rejected');
    const address = addresses[0];
    return await new Promise<string>((resolve, reject) => {
      const req = request(url, { signal, agent: false, lookup: ((_host: string, options: any, callback: any) =>
        options?.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any,
        headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0 ChatForum/1.0' } }, res => {
        if (res.statusCode !== 200 || !/text\/html/i.test(String(res.headers['content-type'])) ||
          res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          res.destroy(); reject(new Error('Search engine unavailable')); return;
        }
        const chunks: Buffer[] = []; let length = 0;
        res.on('data', (part: Buffer) => { length += part.length;
          if (length > 2 * 1024 * 1024) { req.destroy(new Error('Search response too large')); return; } chunks.push(part); });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); res.on('error', reject);
      });
      req.on('error', reject); req.end();
    });
  } finally {
    clearTimeout(timer); outerSignal?.removeEventListener('abort', abort);
    if (cancelDns) signal.removeEventListener('abort', cancelDns);
  }
}
export function parseSearchHtml(html: string, engine: 'DuckDuckGo' | 'Bing', count: number): Array<Omit<WebSource, 'engine' | 'retrievedAt'>> {
  const blocks = engine === 'DuckDuckGo' ? html.split(/<div\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>/gi).slice(1) :
    [...html.matchAll(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
  const results: Array<Omit<WebSource, 'engine' | 'retrievedAt'>> = [];
  for (const block of blocks) {
    const anchor = engine === 'DuckDuckGo' ? /<a\b(?=[^>]*class=["'][^"']*\bresult__a\b[^"']*["'])[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block) :
      /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const url = webSourceUrl(plain(anchor[1])), title = plain(anchor[2]).slice(0, 220);
    const summary = engine === 'DuckDuckGo' ? /<(?:a|div)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block) : /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    if (url && title && !results.some(r => r.url === url)) results.push({ title, url, snippet: plain(summary?.[1] || '').slice(0, 600) });
    if (results.length >= count) break;
  }
  return results;
}
