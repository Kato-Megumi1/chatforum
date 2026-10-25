import { ForumDiscoveryService } from './forum-discovery.service';
import { decodeCursor, encodeCursor } from './forum-discovery.policy';

describe('forum signed count observations', () => {
  test('latest-N does not scan COUNT by default or invent zero as a site total', async () => {
    const prior=process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET='fixture-count-only';
    const queries:string[]=[];
    const tx={user:{findFirst:async()=>({id:1})},postTag:{findMany:async()=>[]},$queryRaw:async(query:any)=>{
      const sql=query.sql||String(query);queries.push(sql);
      if(sql.includes('MAX(id)'))return[{maxId:20}];return[];
    }};
    try { const result=await new ForumDiscoveryService({$transaction:(run:any)=>run(tx)} as any).list({limit:7},{userId:1});
      expect(result.total).toBeNull();expect(result.totalScope).toBe('not_requested');expect(queries.every(sql=>!sql.includes('COUNT('))).toBe(true);
    } finally { if(prior===undefined)delete process.env.JWT_ACCESS_SECRET;else process.env.JWT_ACCESS_SECRET=prior; }
  });
  test('new signed cursors carry counts; incomplete observations and tampering are rejected', () => {
    const now = new Date().toISOString(), payload = { v: 1 as const, filter: 'fixture', asOf: now, since: now,
      maxId: 20, id: 19, at: now, total: 20, totalObservedAt: now };
    const signed = encodeCursor(payload, 'fixture-only');
    expect(decodeCursor(signed, 'fixture', 'fixture-only')).toEqual(payload);
    expect(() => decodeCursor(signed + 'x', 'fixture', 'fixture-only')).toThrow();
    expect(() => decodeCursor(encodeCursor({ ...payload, totalObservedAt: undefined }, 'fixture-only'), 'fixture', 'fixture-only')).toThrow();
    const { total, totalObservedAt, ...legacy } = payload;
    expect(decodeCursor(encodeCursor(legacy, 'fixture-only'), 'fixture', 'fixture-only')).toEqual(legacy);
  });

  test('later pages reuse a signed count but still query current public rows and never claim a current total', async () => {
    const originalSecret = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = 'fixture-count-only';
    const createdAt = new Date(Date.now() - 3600000);
    const row = (id: number) => ({ id, title: '虚构帖子', categoryId: 1, category: '虚构分类', author: '虚构账号',
      createdAt, viewCount: 0, likeCount: 0, commentCount: 0 });
    let first = true;
    const tx = { user: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) }, postTag: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(async (query: any) => {
        if (query.sql.includes('COUNT(*)')) return [{ total: 6n, maxId: 6 }];
        const result = first ? [row(6), row(5), row(4)] : [row(3), row(2), row(1)]; first = false; return result;
      }) };
    const db = { $transaction: (run: (client: any) => unknown) => run(tx) };
    try {
      const service = new ForumDiscoveryService(db as any);
      const page = await service.list({ limit: 2, includeTotal: true }, { userId: 1 });
      const next = await service.list({ limit: 2, cursor: page.nextCursor, includeTotal: true }, { userId: 1 });
      expect(tx.$queryRaw.mock.calls.filter(([query]) => query.sql.includes('COUNT(*)'))).toHaveLength(1);
      expect(next.total).toBe(6); expect(next.totalObservedAt).toBe(page.totalObservedAt); expect(next.totalIsSnapshot).toBe(true);
      expect(next.totalScope).toContain('observation'); expect(next.note).toContain('不是当前全站总数');
      expect(next.posts.map(post => post.id)).toEqual([3, 2]);
      expect(tx.$queryRaw.mock.calls.at(-1)[0].sql).toContain("p.status='APPROVED'");
    } finally {
      if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = originalSecret;
    }
  });
});
