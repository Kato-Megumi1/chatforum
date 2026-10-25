import { randomUUID } from 'crypto';
import { createServer, Server } from 'http';
import { PrismaService } from '../../common/prisma.service';
import { ForumDiscoveryService } from './forum-discovery.service';
import { AgentExecutorService } from '../agent/agent.executor';
import { SkillRegistry } from '../agent/skills';
import { ForumHotTopicsSkill } from '../agent/skills/forum-hot-topics.skill';
import { ForumDetailSkill } from '../agent/skills/forum-detail.skill';
import { ChatService } from '../chat/chat.service';
import { RedisService } from '../../common/redis.service';
import { ForumHotWorkerService } from './forum-hot-worker.service';
import { ForumSnapshotService } from './forum-snapshot.service';

const suite = process.env.RUN_FORUM_DISCOVERY_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated SQL/forum tools/protocol integration', () => {
  let db: PrismaService, service: ForumDiscoveryService, owner: number, other: number, conversationId: number, roleConversationId: number;
  let redis: RedisService, worker: ForumHotWorkerService;
  const originalHotFlag = process.env.FORUM_HOT_PRECOMPUTE_ENABLED, originalSecret = process.env.JWT_ACCESS_SECRET;
  const categoryIds: number[] = [], userIds: number[] = [];
  const scope = () => ({ userId: owner, conversationId });
  const category = async () => { const c = await db.category.create({ data: { name: 'forum-fixture-' + randomUUID().slice(0, 8) } }); categoryIds.push(c.id); return c; };
  const post = (categoryId: number, data: any = {}) => db.post.create({ data: { categoryId, userId: owner, title: '虚构测试帖子', content: '仅用于测试，非真实用户内容。', status: 'APPROVED', createdAt: new Date(Date.now()-3600000), ...data } });
  const discovery = () => new ForumDiscoveryService(db, new ForumSnapshotService(db, redis, worker));
  const warm = (categoryId: number) => worker.publishScope({ hours: 168, categoryId, rankingBasis: 'published' });
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test' ||
      process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '36386' || process.env.REDIS_PASSWORD) throw Error('Refusing non-fixture DB or Redis');
    process.env.JWT_ACCESS_SECRET = 'forum-discovery-fixture-only-at-least-32';
    process.env.FORUM_HOT_PRECOMPUTE_ENABLED = 'true';
    process.env.LANGCHAIN_TRACING_V2 = 'false'; process.env.LANGSMITH_TRACING = 'false';
    db = new PrismaService(); await db.$connect(); redis = new RedisService(); redis.onModuleInit(); await redis.getClient().ping();
    worker = new ForumHotWorkerService(db, redis); service = discovery();
    for (let i=0; i<2; i++) { const name = 'forum_' + randomUUID(); const u = await db.user.create({ data: { username: name, email: name+'@example.test', password: 'disabled-fixture' } }); userIds.push(u.id); }
    [owner, other] = userIds;
    conversationId = (await db.conversation.create({ data: { userId: owner, title: '虚构普通AI', conversationType: 'ASSISTANT', personaKey: 'assistant' } })).id;
    roleConversationId = (await db.conversation.create({ data: { userId: owner, title: '虚构角色', conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona' } })).id;
  });
  afterAll(async () => {
    await worker?.onModuleDestroy();
    for (const categoryId of categoryIds) {
      const hash = worker.scopeKey({ hours: 168, categoryId, rankingBasis: 'published' });
      let cursor = '0'; do { const [next, keys] = await redis.getClient().scan(cursor, 'MATCH', 'forum:hot:v2:{' + hash + '}:*', 'COUNT', 100);
        if (keys.length) await redis.getClient().del(...keys); cursor = next;
      } while (cursor !== '0');
      await db.forumReadModelState.deleteMany({ where: { key: 'hot:v2:' + hash } });
    }
    await db.category.deleteMany({ where: { id: { in: categoryIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } }); await db.$disconnect();
    if (redis) await redis.getClient().quit();
    if (originalHotFlag === undefined) delete process.env.FORUM_HOT_PRECOMPUTE_ENABLED; else process.env.FORUM_HOT_PRECOMPUTE_ENABLED = originalHotFlag;
    if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = originalSecret;
  });
  test('true top post is beyond the old arbitrary 50-row pool; all sort modes rank before limit', async () => {
    const c = await category();
    await db.post.createMany({ data: Array.from({ length: 65 }, (_, i) => ({ categoryId: c.id, userId: owner, title: '候选'+i,
      content: '不应整篇传给模型'.repeat(1000), status: 'APPROVED' as const, createdAt: new Date(Date.now()-3600000), viewCount: 1 })) });
    const winner = await post(c.id, { viewCount: 900, likeCount: 800, commentCount: 700 });
    await post(c.id, { status: 'REJECTED', viewCount: 99999, likeCount: 99999 });
    await post(c.id, { createdAt: new Date(Date.now()-40*86400000), viewCount: 99999, likeCount: 99999 });
    expect(await warm(c.id)).toBe(true);
    for (const sortBy of ['hotness', 'views', 'likes', 'comments']) {
      const result = await service.hot({ categoryId: c.id, sortBy, limit: 1 }, scope());
      expect(result.posts.map(p => p.id)).toEqual([winner.id]); expect(result.posts[0]).not.toHaveProperty('content');
      expect(result.ranking.basis).toContain('累计');
    }
  });
  test('hot deltas survive service restart, stay scoped, and do not expose withdrawn posts', async () => {
    const c = await category(), a = await post(c.id, { likeCount: 10 }), b = await post(c.id, { likeCount: 5 });
    expect(await warm(c.id)).toBe(true);
    expect((await service.hot({ categoryId: c.id, limit: 2 }, scope())).comparison.status).toBe('baseline_created');
    await db.post.update({ where: { id: b.id }, data: { likeCount: 20 } });
    expect(await warm(c.id)).toBe(true);
    const result = await discovery().hot({ categoryId: c.id, limit: 2 }, scope());
    expect(result.comparison.status).toBe('compared'); expect(result.comparison.changes[0]).toMatchObject({ postId: b.id, rankChange: 1, delta: { likes: 15 } });
    expect((await service.hot({ categoryId: c.id, limit: 2 }, { userId: owner, conversationId: roleConversationId })).comparison.status).toBe('baseline_created');
    await db.post.update({ where: { id: a.id }, data: { status: 'REJECTED' } });
    const now = await service.hot({ categoryId: c.id, limit: 2 }, scope());
    expect(now.posts.some(p => p.id === a.id)).toBe(false); expect(now.comparison.changes.some(p => p.postId === a.id)).toBe(false);
  });
  test('stable keyset pages preserve same-time rows, exclude inserts, resume next across turns and reject stolen cursors', async () => {
    const c = await category(), at = new Date(Date.now()-1800000), ids: number[] = [];
    for (let i=0; i<11; i++) ids.push((await post(c.id, { createdAt: at })).id);
    let page = await service.list({ categoryId: c.id, limit: 4, includeTotal: true }, scope()); const all = page.posts.map(p => p.id);
    expect(page.total).toBe(11); expect(page.hasMore).toBe(true);
    await expect(service.list({ categoryId: c.id, limit: 4, cursor: page.nextCursor }, { userId: other })).rejects.toThrow();
    // Even a backdated insert must not sneak into the fixed maxId snapshot.
    const inserted = await post(c.id, { createdAt: at });
    while (page.hasMore) { page = await new ForumDiscoveryService(db).list({ categoryId: c.id, limit: 4, cursor: 'next' }, scope()); all.push(...page.posts.map(p => p.id)); }
    expect(all).toEqual(ids.reverse()); expect(all).not.toContain(inserted.id); expect(new Set(all).size).toBe(11);
    await expect(service.list({ categoryId: c.id, cursor: 'next' }, scope())).rejects.toThrow('NO_NEXT_PAGE');
  });
  test('since-last is explicit, empty is not an outage, and category names and literal keywords filter correctly', async () => {
    const c = await category(); await post(c.id, { title: '眼镜礼物讨论' });
    const first = await service.list({ category: c.name, sinceLastQuery: true }, scope()); expect(first.baselineAvailable).toBe(false);
    const fresh = await post(c.id, { title: '新讨论', createdAt: new Date() });
    const second = await service.list({ category: c.name, sinceLastQuery: true }, scope());
    expect(second.baselineAvailable).toBe(true); expect(second.posts.map(p => p.id)).toEqual([fresh.id]);
    expect((await service.list({ category: c.name, query: "%' OR 1=1 --" }, scope(), true)).posts).toEqual([]);
    const matches = await service.list({ category: c.name, query: '眼镜 礼物' }, scope(), true);
    expect(matches.posts).toHaveLength(1); expect(matches.posts[0].title).toBe('眼镜礼物讨论');
    await post(c.id, { title: '去年历史关键词', createdAt: new Date(Date.now()-365*86400000) });
    expect((await service.list({ categoryId: c.id, query: '历史关键词' }, scope(), true)).posts).toHaveLength(1);
    expect((await service.list({ categoryId: c.id, query: '历史关键词', hours: 24 }, scope(), true)).posts).toHaveLength(0);
    await expect(service.list({ query: '  ' }, scope(), true)).rejects.toThrow();
  });
  test('latest seven resets an empty 24h window and includes older-than-30-day posts; explicit windows remain bounded', async () => {
    const c = await category(), ids: number[] = [];
    for (const days of [2, 5, 15, 31, 60, 80, 100, 120])
      ids.push((await post(c.id, { createdAt: new Date(Date.now()-days*86400000), title: '最新数量测试' })).id);
    await post(c.id, { status: 'REJECTED', createdAt: new Date() });
    const empty = await service.list({ categoryId: c.id, timeRange: 'window', hours: 24, includeTotal: true }, scope());
    expect(empty.total).toBe(0); expect(empty.posts).toHaveLength(0);
    const latest = await service.list({ categoryId: c.id, limit: 7, timeRange: 'all', includeTotal: true }, scope());
    expect(latest.posts.map(p => p.id)).toEqual(ids.slice(0,7));
    expect(latest).toMatchObject({ total: 8, returnedCount: 7, requestedLimit: 7, timeRange: 'all', hours: null, hasMore: true });
    const next = await service.list({ categoryId: c.id, timeRange: 'all', cursor: 'next', limit: 7 }, scope());
    expect(next.posts.map(p => p.id)).toEqual(ids.slice(7));
    const week = await service.list({ categoryId: c.id, limit: 7, timeRange: 'window', hours: 168, includeTotal: true }, scope());
    expect(week.posts.map(p => p.id)).toEqual(ids.slice(0,2));
    expect(week).toMatchObject({ total: 2, timeRange: 'window', requestedLimit: 7, returnedCount: 2, hasMore: false });
    const ninetyDays = await service.list({ categoryId: c.id, limit: 7, timeRange: 'window', hours: 2160 }, scope());
    expect(ninetyDays.posts.map(p => p.id)).toEqual(ids.slice(0,6));
    await expect(service.list({ categoryId: c.id, timeRange: 'all', hours: 720 }, scope())).rejects.toThrow();
  });
  test('search snippets surround matches, detail is chunked/read-only, inactive comments and private user fields excluded', async () => {
    const c = await category(), p = await post(c.id, { content: '开头无关'.repeat(400)+'目标关键词'+'后文'.repeat(1000) });
    await db.comment.createMany({ data: [{ postId: p.id, userId: owner, content: '正常评论', status: 'ACTIVE' },
      { postId: p.id, userId: owner, content: '已删除内容不能外发', status: 'DELETED' }] });
    const search = await service.list({ categoryId: c.id, query: '目标关键词' }, scope(), true);
    expect(search.posts[0].snippet).toContain('目标关键词'); expect(search.posts[0].snippet.length).toBeLessThanOrEqual(240);
    const detail = await service.detail({ postId: p.id }, scope()); expect(detail.content.length).toBe(1800); expect(detail.nextOffset).toBe(1800);
    expect(detail.comments.map(c => c.content)).toEqual(['正常评论']); expect(JSON.stringify(detail)).not.toContain('example.test');
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).viewCount).toBe(p.viewCount);
    await db.post.update({ where: { id: p.id }, data: { status: 'REJECTED' } });
    await expect(service.detail({ postId: p.id }, scope())).rejects.toThrow('FORUM_POST_UNAVAILABLE');
  });
  test('current account and conversation ownership checked; nothing accepts client-supplied user scope', async () => {
    await expect(service.hot({}, {})).rejects.toThrow('FORUM_ACCESS_DENIED');
    await expect(service.hot({}, { userId: other, conversationId })).rejects.toThrow('FORUM_ACCESS_DENIED');
    await db.user.update({ where: { id: other }, data: { status: 'BANNED' } });
    await expect(service.categories({ userId: other })).rejects.toThrow('FORUM_ACCESS_DENIED');
    await expect(service.hot({ userId: owner }, { userId: other })).rejects.toThrow();
  });
  test('deleting a source message invalidates forum checkpoints as well as dialogue caches', async () => {
    const c = await category(); expect(await warm(c.id)).toBe(true); await service.hot({ categoryId: c.id }, scope());
    const message = await db.chatMessage.create({ data: { conversationId, role: 'USER', content: '虚构查询历史' } });
    expect(await db.forumQueryCheckpoint.count({ where: { conversationId } })).toBeGreaterThan(0);
    await new ChatService(db, {} as any).deleteMessage(conversationId, message.id, owner);
    expect(await db.forumQueryCheckpoint.count({ where: { conversationId } })).toBe(0);
  });
  test('real LangChain hot→detail protocol carries server identity and structured sources; moderation rechecked before delivery', async () => {
    const c = await category(), p = await post(c.id, { title: '协议测试帖', content: '测试摘要依据。' });
    expect(await warm(c.id)).toBe(true);
    SkillRegistry.register(new ForumHotTopicsSkill(service), { name: 'get_hot_topics', description: 'fixture', category: '论坛', enabled: true });
    SkillRegistry.register(new ForumDetailSkill(service), { name: 'get_forum_post', description: 'fixture', category: '论坛', enabled: true });
    const received: any[] = []; let withdraw = false, invalidFirst = false;
    const server: Server = createServer(async (req,res) => {
      let raw=''; for await (const chunk of req) raw+=chunk; const body=JSON.parse(raw); received.push(body);
      const count=body.messages.filter((m:any)=>m.role==='tool').length;
      const round=count-(invalidFirst?1:0), needsTool=round<2;
      const message=needsTool?{role:'assistant',content:null,tool_calls:[{id:'call_'+count,type:'function',function:{
        name:round>=1?'get_forum_post':'get_hot_topics',arguments:JSON.stringify(round>=1?{postId:p.id}:{categoryId:c.id,limit:round<0?-1:2})}}]}:
        {role:'assistant',content:`[协议测试帖](/forum/post/${p.id})：测试摘要依据。`};
      if (!needsTool && withdraw) await db.post.update({ where: { id:p.id }, data:{status:'REJECTED'} });
      if (body.stream) {
        res.setHeader('Content-Type','text/event-stream');
        const delta=needsTool?{...message,tool_calls:[{...message.tool_calls[0],index:0}]}:message;
        res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',
          choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
        res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',
          choices:[{index:0,delta:{},finish_reason:needsTool?'tool_calls':'stop'}]})+'\n\n');
        res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[],
          usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}})+'\n\n');
        res.end('data: [DONE]\n\n'); return;
      }
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',
        choices:[{index:0,message,finish_reason:needsTool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}));
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const base='http://127.0.0.1:'+(server.address() as any).port+'/v1', executor=new AgentExecutorService(db);
      const run=()=>executor.executeWithTools([{role:'user',content:'看看热帖并读一下详情'}],'fixture',base,'fixture',0,200,
        ['get_hot_topics','get_forum_post'],'测试助手',undefined,undefined,undefined,undefined,scope());
      const answer=await run(); expect(answer.content).toContain(`/forum/post/${p.id}`); expect(answer.toolOutputs).toHaveLength(2);
      expect(received[0].tools.find((t:any)=>t.function.name==='get_hot_topics').function.parameters.required).toEqual([]);
      expect(received[0].tools.find((t:any)=>t.function.name==='get_forum_post').function.parameters.required).toEqual(['postId']);
      expect(answer.toolOutputs[0]).toMatchObject({success:true,result:{kind:'hot'}});
      expect(received[0].messages.some((m:any)=>m.content.includes('不可信数据'))).toBe(true);
      const tool=received[1].messages.find((m:any)=>m.role==='tool'); expect(JSON.parse(tool.content).data.posts[0].id).toBe(p.id);
      invalidFirst=true;
      const recovered=await run();expect(recovered.content).toContain(`/forum/post/${p.id}`);
      expect(recovered.toolOutputs.map(t=>t.success)).toEqual([false,true,true]);invalidFirst=false;
      withdraw=true; await expect(run()).rejects.toThrow('帖子已变化或下架');
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  }, 20000);
});
