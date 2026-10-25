import { MemoryControlsService, memorySourceHash, memorySourceIds } from './memory-controls.service';
import { buildConversationMemory, ConversationFrame } from './conversation-memory.policy';

describe('source-bound user memory controls', () => {
  const date = new Date('2026-01-01T00:00:00Z');
  const make = () => {
    const scope: any = { id: 10, userId: 1, personaKey: 'assistant', conversationType: 'ASSISTANT', memoryEpoch: 2,
      title: 'synthetic memory', personaLabel: null, sharedMemory: false };
    const source: any[] = [
      { id: 20, role: 'USER', content: '我喜欢蓝色', createdAt: date },
      { id: 21, role: 'ASSISTANT', content: '记住了', createdAt: date, ragMetadata: { personaKey: 'assistant', state: 'ungrounded' }, reasoningContent: 'private reasoning' },
    ];
    const episode = { conversationId: 10, personaKey: 'assistant', lastMessageId: 21,
      text: 'untrusted stale cached text', sourceIds: [20, 21], evidence: { secret: 'not a current citation' } };
    const pins: any[] = [];
    let suppressed: number[] = [];
    const db: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
      user: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      conversation: { findFirst: jest.fn(async ({ where }: any) => where.id === scope.id && where.userId === scope.userId ? { ...scope } : null),
        findMany: jest.fn().mockResolvedValue([]), update: jest.fn(async () => { scope.memoryEpoch++; return scope; }) },
      chatMessage: { findMany: jest.fn(async ({ where }: any) => source.filter(row => where.id.in.includes(row.id))) },
      conversationEpisode: { findMany: jest.fn().mockResolvedValue([episode]), findUnique: jest.fn().mockResolvedValue(episode), deleteMany: jest.fn() },
      conversationMemoryPin: {
        findMany: jest.fn(async () => [...pins]), findUnique: jest.fn(async ({ where }: any) => pins.find(pin => pin.sourceHash === where.conversationId_sourceHash.sourceHash)),
        findFirst: jest.fn(async ({ where }: any) => pins.find(pin => pin.id === where.id)), count: jest.fn(async () => pins.length),
        create: jest.fn(async ({ data }: any) => { const pin = { id: 30, revision: 1, ...data }; pins.push(pin); return pin; }),
        delete: jest.fn(async () => { pins.splice(0); }), deleteMany: jest.fn(),
      },
      conversationMemorySuppression: { count: jest.fn(async ({ where }: any) => suppressed.filter(id => where.messageId.in.includes(id)).length),
        findMany: jest.fn(async ({ where }: any) => suppressed.filter(id => where.messageId.in.includes(id)).map(messageId => ({ messageId }))),
        createMany: jest.fn(async ({ data }: any) => { suppressed = data.map((row: any) => row.messageId); }) },
      memoryRebuildJob: { findUnique: jest.fn().mockResolvedValue({ status: 'READY', epoch: 2 }), upsert: jest.fn() },
      conversationMemory: { deleteMany: jest.fn() }, forumQueryCheckpoint: { deleteMany: jest.fn() },
    };
    db.$transaction = jest.fn(async (work: any) => work(db));
    const service = new MemoryControlsService(db);
    return { db, service, scope, source, episode, pins, suppress: (ids: number[]) => { suppressed = ids; } };
  };
  const entry = async (f: ReturnType<typeof make>) => (await f.service.entries(1, 10)).items[0];
  const action = (entry: any) => ({ kind: entry.kind, id: entry.id, version: entry.version });

  test('source identity accepts only bounded positive IDs and hashes authoritative fields, not provider reasoning', () => {
    expect(memorySourceIds([1, 1, 2])).toEqual([1, 2]);
    for (const value of [[], [0], [-1], ['1'], Array.from({ length: 9 }, (_, i) => i + 1), null]) expect(memorySourceIds(value)).toEqual([]);
    const base: any = { id: 1, role: 'USER', content: 'source', createdAt: date };
    expect(memorySourceHash([base])).toBe(memorySourceHash([{ ...base, reasoningContent: 'secret', ragMetadata: { private: true } }]));
    expect(memorySourceHash([base])).not.toBe(memorySourceHash([{ ...base, content: 'changed source' }]));
  });
  test('entries are reconstructed from source rows and stale cached text is not treated as truth', async () => {
    const f = make(), item = await entry(f);
    expect(item.text).toContain('我喜欢蓝色'); expect(item.text).not.toContain('untrusted stale cached text');
    expect(item).toMatchObject({ kind: 'episode', id: 21, sourceIds: [20, 21], pinned: false });
    f.suppress([20]); expect((await f.service.entries(1, 10)).items).toEqual([]);
    f.suppress([]); f.source[1].ragMetadata.personaKey = 'other-role';
    expect((await f.service.entries(1, 10)).items).toEqual([]);
  });
  test('source view omits reasoning, metadata and evidence while long source text is explicitly bounded', async () => {
    const f = make(); f.source[1].content = 'x'.repeat(13000);
    const item = await entry(f), result = await f.service.sources(1, 10, action(item));
    expect(result.messages[1]).toMatchObject({ id: 21, role: 'assistant', truncated: true });
    expect(result.messages[1].content).toHaveLength(12000);
    expect(result.messages[1]).not.toHaveProperty('ragMetadata'); expect(result.messages[1]).not.toHaveProperty('reasoningContent');
    expect(JSON.stringify(result)).not.toContain('private reasoning');
    expect(f.db.chatMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ reasoningContent: true }) }));
  });
  test('current active account, ownership and explicit persona identity are required', async () => {
    const f = make(); await expect(f.service.entries(2, 10)).rejects.toThrow('不可访问');
    f.db.user.findUnique.mockResolvedValue({ status: 'DISABLED' }); await expect(f.service.conversations(1)).rejects.toThrow('账号不可用');
    f.db.user.findUnique.mockResolvedValue({ status: 'ACTIVE' }); f.scope.conversationType = 'LEGACY';
    await expect(f.service.entries(1, 10)).rejects.toThrow('旧历史');
    await expect(f.service.entries(1, -1)).rejects.toThrow('编号');
  });
  test('pin locks the account and conversation, deduplicates source hash and enforces the bounded pin limit', async () => {
    const f = make(), item = await entry(f);
    expect(await f.service.pin(1, 10, action(item))).toMatchObject({ pinned: true, id: 30 });
    await f.service.pin(1, 10, action(item)); expect(f.db.conversationMemoryPin.create).toHaveBeenCalledTimes(1);
    expect(f.db.$queryRaw).toHaveBeenCalled();
    expect(f.pins[0]).toMatchObject({ personaKey: 'assistant', sourceIds: [20, 21] });
    expect(f.pins[0]).not.toHaveProperty('evidence'); expect(f.pins[0].text).not.toContain('untrusted stale');
    const pinned = await entry(f); expect(pinned.kind).toBe('pin');
    await f.service.unpin(1, 10, action(pinned)); expect(f.pins).toEqual([]);
    f.db.conversationMemoryPin.count.mockResolvedValue(12);
    await expect(f.service.pin(1, 10, action(item))).rejects.toThrow('最多固定12段');
  });
  test('epoch, source text and persona changes reject stale actions rather than silently re-binding', async () => {
    const f = make(), item = await entry(f);
    f.scope.memoryEpoch++; await expect(f.service.pin(1, 10, action(item))).rejects.toThrow('版本已改变');
    f.scope.memoryEpoch--; f.source[0].content = 'new text';
    await expect(f.service.sources(1, 10, action(item))).rejects.toThrow('版本已改变');
    f.source.splice(0, 1); await expect(f.service.sources(1, 10, action(item))).rejects.toThrow('来源');
    await expect(f.service.sources(1, 10, { ...action(item), version: 'client-controlled' })).rejects.toThrow('版本');
  });
  test('forget suppresses both source messages, invalidates derived cache and queues the next epoch without deleting originals', async () => {
    const f = make(), item = await entry(f); await f.service.forget(1, 10, action(item));
    expect(f.source).toHaveLength(2); expect(f.scope.memoryEpoch).toBe(3);
    expect(f.db.conversationMemorySuppression.createMany).toHaveBeenCalledWith({ data: [
      { userId: 1, conversationId: 10, messageId: 20 }, { userId: 1, conversationId: 10, messageId: 21 }], skipDuplicates: true });
    expect(f.db.conversationMemory.deleteMany).toHaveBeenCalledWith({ where: { conversationId: 10 } });
    expect(f.db.conversationEpisode.deleteMany).toHaveBeenCalled(); expect(f.db.forumQueryCheckpoint.deleteMany).toHaveBeenCalled();
    expect(f.db.memoryRebuildJob.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ epoch: 3, status: 'QUEUED', workerToken: null }) }));
    expect(await f.service.filterMessages(1, 10, [{ messageId: 20 }, { messageId: 21 }, { messageId: 22 }])).toEqual([{ messageId: 22 }]);
  });
  test('applying a pin clearly labels historical user excerpt, preserves non-canonical summary and rejects old frame epoch', async () => {
    const f = make(), item = await entry(f); await f.service.pin(1, 10, action(item));
    const built = buildConversationMemory([], 'assistant');
    const frame: ConversationFrame = { sourceEpoch: 2, history: [], persona: '', question: 'fixture', memory: built.snapshot };
    const applied = await f.service.applyToFrame(1, 10, frame);
    expect(applied.memory.summary.kind).toBe('extractive_not_canon');
    expect(applied.memory.summary.text).toContain('用户固定的历史摘录，非正史依据');
    expect(applied.memory.summary.text).toContain('我喜欢蓝色');
    await expect(f.service.applyToFrame(1, 10, { ...frame, sourceEpoch: 1 })).rejects.toThrow();
    await expect(f.service.applyToFrame(1, 10, { ...frame, memory: { ...frame.memory, personaKey: 'different' } })).rejects.toThrow();
  });
  test('a pinned source whose recorded persona changed is not injected even when text hash is unchanged', async () => {
    const f = make(), item = await entry(f); await f.service.pin(1, 10, action(item));
    f.source[1].ragMetadata.personaKey = 'another-role';
    const built = buildConversationMemory([], 'assistant');
    const frame: ConversationFrame = { sourceEpoch: 2, history: [], persona: '', question: 'fixture', memory: built.snapshot };
    expect((await f.service.entries(1, 10)).items).toEqual([]);
    expect((await f.service.applyToFrame(1, 10, frame)).memory.summary.text).not.toContain('我喜欢蓝色');
  });
  test('twelve long pins share the reserved context space instead of starving older fixed entries', async () => {
    const f=make(),base=await entry(f);await f.service.pin(1,10,action(base));
    const pin=f.pins[0];f.pins.splice(0,1,...Array.from({length:12},(_,index)=>({...pin,id:30+index,text:'固定'+index+'：'+('有源长摘录'.repeat(300))})));
    const frame:ConversationFrame={sourceEpoch:2,history:[],persona:'',question:'fixture',memory:buildConversationMemory([],'assistant').snapshot};
    const result=await f.service.applyToFrame(1,10,frame);
    expect(result.memory.summary.topics).toHaveLength(12);
    expect(result.memory.summary.text.length).toBeLessThanOrEqual(2512);
    for(let index=0;index<12;index++)expect(result.memory.summary.text).toContain('固定'+index+'：');
    expect(result.memory.summary.text).toContain('摘录有省略，来源保留');
  });
  test('a stale cached relationship state cannot reintroduce suppressed names, preferences or commitments', async () => {
    const f = make(), built = buildConversationMemory([], 'assistant'); f.suppress([20, 21]);
    const forgotten = { messageId: 20, speaker: 'user' as const, quote: 'old fixture' };
    const kept = { messageId: 22, speaker: 'user' as const, quote: 'still visible fixture' };
    const frame: ConversationFrame = { sourceEpoch: 2, persona: '', question: 'fixture',
      history: [{ role: 'user', content: 'forgotten', messageId: 20 }, { role: 'assistant', content: 'kept', messageId: 22 }],
      evidenceHistory: [{ role: 'assistant', content: 'forgotten reply', messageId: 21 }],
      memory: { ...built.snapshot, state: { ...built.snapshot.state,
        name: { value: '旧名字', source: forgotten }, address: { value: '保留称呼', source: kept },
        preferences: [{ value: '旧偏好', source: forgotten }, { value: '保留偏好', source: kept }],
        familiarity: 'explicitly_friends', familiaritySources: [forgotten],
        invitation: { activity: '电影', status: 'accepted_activity_only', sources: [forgotten, kept] },
        affection: { user: 'expressed', source: forgotten },
        relationship: { status: 'mutually_explicit', sources: [forgotten] } } } };
    const result = await f.service.applyToFrame(1, 10, frame);
    expect(result.history.map(row => row.messageId)).toEqual([22]); expect(result.evidenceHistory).toEqual([]);
    expect(result.memory.state.name).toBeUndefined(); expect(result.memory.state.address?.value).toBe('保留称呼');
    expect(result.memory.state.preferences.map(preference => preference.value)).toEqual(['保留偏好']);
    expect(result.memory.state.familiarity).toBe('not_established'); expect(result.memory.state.familiaritySources).toEqual([]);
    expect(result.memory.state.invitation).toBeUndefined(); expect(result.memory.state.affection).toBeUndefined();
    expect(result.memory.state.relationship).toEqual({ status: 'not_established', sources: [] });
  });
});
