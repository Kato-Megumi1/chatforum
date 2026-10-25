import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';

export interface LatestFeedCursor { v: 1; kind: 'latest'; filter: string; asOf: string; maxId: number; at: string | null; id: number | null; }
export interface HotFeedCursor { v: 1; kind: 'hot'; filter: string; asOf: string; snapshotId: string; offset: number; }
export interface TagOptionCursor { v: 1; kind: 'tags'; filter: string; asOf: string; name: string; id: number; }
export type WebForumCursor = LatestFeedCursor | HotFeedCursor | TagOptionCursor;
export const webFilterKey = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const common = { v: z.literal(1), filter: z.string().regex(/^[a-f0-9]{64}$/), asOf: z.string().datetime() };
const cursorSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('latest'), maxId: z.number().int().nonnegative().max(2147483647),
    at: z.string().datetime().nullable(), id: z.number().int().positive().max(2147483647).nullable() }).strict(),
  z.object({ ...common, kind: z.literal('hot'), snapshotId: z.string().min(1).max(300), offset: z.number().int().min(0).max(200) }).strict(),
  z.object({ ...common, kind: z.literal('tags'), name: z.string().min(1).max(191), id: z.number().int().positive().max(2147483647) }).strict(),
]);
function signature(data: string, secret: string) {
  if (!secret || secret.length < 32) throw new ServiceUnavailableException('论坛分页服务暂不可用');
  return createHmac('sha256', secret).update('forum-web-cursor-v1\0' + data).digest();
}
export function signWebCursor(value: WebForumCursor, secret: string) {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return data + '.' + signature(data, secret).toString('base64url');
}
export function readWebCursor(value: string, filter: string, kind: WebForumCursor['kind'], secret: string): WebForumCursor {
  if (typeof value !== 'string' || value.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(value)) throw new BadRequestException('分页凭据无效，请刷新列表');
  const [data, signed] = value.split('.'), expected = signature(data, secret), supplied = Buffer.from(signed, 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new BadRequestException('分页凭据无效，请刷新列表');
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))) as WebForumCursor;
    const at = Date.parse(parsed.asOf);
    if (parsed.filter !== filter || parsed.kind !== kind || at > Date.now() + 5000 || at < Date.now() - 24 * 3600000 ||
      parsed.kind === 'latest' && ((parsed.at === null) !== (parsed.id === null) || parsed.id > parsed.maxId || parsed.at && Date.parse(parsed.at) > at))
      throw Error('Invalid cursor scope');
    return parsed;
  } catch { throw new BadRequestException('分页凭据无效或已过期，请刷新列表'); }
}
