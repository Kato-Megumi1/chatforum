import { createHash } from 'node:crypto';
import { FileDraftService, FILE_DRAFT_VERSION } from './file-draft.service';

const id = '10000000-0000-4000-8000-000000000001';
const scope = { userId: 3, conversationId: 4, runId: id, conversationEpoch: 7, workerToken: 'current-worker' };
const source = { path: 'pelican.html', content: '<!doctype html>\n<html>\n<body>', closed: false,
  originalQuestion: '写一个演示页面', reason: 'OUTPUT_LIMIT' };
function fixture() {
  const row: any = { privateState: null, status: 'RUNNING', userId: 3, conversationId: 4,
    workerToken: 'current-worker', leaseUntil: new Date(Date.now() + 60000) };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ memoryEpoch: 7 }]),
    chatRun: {
      findFirst: jest.fn(async ({ where }: any) => {
        const statuses = typeof where.status === 'string' ? [where.status] : where.status.in;
        return where.id === id && where.userId === row.userId && where.conversationId === row.conversationId && statuses.includes(row.status) &&
          (!where.workerToken || where.workerToken === row.workerToken) &&
          (!where.leaseUntil || row.leaseUntil > where.leaseUntil.gt) ? { privateState: row.privateState } : null;
      }),
      updateMany: jest.fn(async ({ data }: any) => { row.privateState = data.privateState; return { count: 1 }; }),
    },
  };
  const prisma = { $transaction: jest.fn(async (work: any) => work(tx)) };
  return { service: new FileDraftService(prisma as any), tx, row, prisma };
}

describe('private durable file drafts', () => {
  test('checkpoints only source and returns a safe version pointer, not content', async () => {
    const f = fixture(), pointer = await f.service.checkpoint(scope, source);
    expect(pointer).toEqual({ draftId: id, revision: 1,
      hash: createHash('sha256').update(source.content, 'utf8').digest('hex') });
    expect(f.row.privateState).toEqual({ ...source, kind: FILE_DRAFT_VERSION,
      conversationEpoch: 7, revision: 1, hash: pointer.hash });
    expect(f.tx.chatRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id, userId: 3, conversationId: 4, status: 'RUNNING', workerToken: scope.workerToken }),
      data: { privateState: f.row.privateState },
    }));
    expect(pointer).not.toHaveProperty('content');
  });

  test('unchanged content keeps revision; append advances revision and invalidates old pointer', async () => {
    const f = fixture();
    const first = await f.service.checkpoint(scope, source);
    expect(await f.service.checkpoint(scope, { ...source, reason: 'CHANNEL_UNCLOSED' })).toEqual(first);
    const second = await f.service.checkpoint(scope, { ...source, content: source.content + '\n<p>hello</p>' });
    expect(second.revision).toBe(2);
    f.row.status = 'COMPLETED';
    await expect(f.service.read(3, 4, first)).rejects.toThrow('版本已失效');
    expect(await f.service.read(3, 4, second)).toMatchObject({ ...second,
      content: source.content + '\n<p>hello</p>', originalQuestion: source.originalQuestion, conversationEpoch: 7 });
  });

  test('end marker may change closed state without changing the content version', async () => {
    const f = fixture();
    const first = await f.service.checkpoint(scope, source);
    expect(await f.service.checkpoint(scope, { ...source, closed: true, reason: 'FILE_FORMAT' })).toEqual(first);
    f.row.status = 'FAILED';
    expect(await f.service.read(3, 4, first)).toMatchObject({ closed: true, reason: 'FILE_FORMAT' });
  });

  test.each(['QUEUED', 'COMPLETED', 'FAILED', 'CANCELLED'])('does not checkpoint a %s run', async status => {
    const f = fixture(); f.row.status = status;
    await expect(f.service.checkpoint(scope, source)).rejects.toThrow('任务已结束');
    expect(f.tx.chatRun.updateMany).not.toHaveBeenCalled();
  });

  test('stale worker, expired lease and cancellation race cannot write', async () => {
    for (const alter of [
      (f: ReturnType<typeof fixture>) => { f.row.workerToken = 'new-worker'; },
      (f: ReturnType<typeof fixture>) => { f.row.leaseUntil = new Date(Date.now() - 1000); },
      (f: ReturnType<typeof fixture>) => { f.tx.chatRun.updateMany.mockResolvedValue({ count: 0 }); },
    ]) {
      const f = fixture(); alter(f);
      await expect(f.service.checkpoint(scope, source)).rejects.toThrow('任务已结束');
    }
  });

  test('late shorter snapshots, unrelated files and changed requirements never overwrite a newer draft', async () => {
    const f = fixture();
    await f.service.checkpoint(scope, { ...source, content: source.content + '\nnew content' });
    const saved = f.row.privateState;
    for (const candidate of [source, { ...source, path: 'other.html' }, { ...source, originalQuestion: '另一要求' }])
      await expect(f.service.checkpoint(scope, candidate)).rejects.toThrow('未覆盖');
    expect(f.row.privateState).toBe(saved);
    expect(f.tx.chatRun.updateMany).toHaveBeenCalledTimes(1);
  });

  test('messages deleted during generation or before continuation invalidate the epoch', async () => {
    const f = fixture(), pointer = await f.service.checkpoint(scope, source);
    f.tx.$queryRaw.mockResolvedValue([{ memoryEpoch: 8 }]);
    await expect(f.service.checkpoint(scope, { ...source, content: source.content + 'next' })).rejects.toThrow('对话消息已改变');
    f.row.status = 'COMPLETED';
    await expect(f.service.read(3, 4, pointer)).rejects.toThrow('版本已失效');
  });

  test('complete local repair requires the current content hash and cannot overwrite a later repair', async () => {
    const f = fixture();
    const first = await f.service.checkpoint(scope, { ...source, closed: true, content: '<html><body>bad syntax</body></html>' });
    const repair = { ...source, content: '<html><body>fixed</body></html>', closed: true, reason: 'FILE_FORMAT', baseHash: first.hash };
    const second = await f.service.checkpoint(scope, repair);
    expect(second.revision).toBe(2);
    expect(f.row.privateState).not.toHaveProperty('baseHash');
    await expect(f.service.checkpoint(scope, { ...repair, content: '<html><body>late</body></html>' })).rejects.toThrow('未覆盖');
    await expect(f.service.checkpoint(scope, { ...repair, closed: false, baseHash: second.hash })).rejects.toThrow('未覆盖');
    expect(f.row.privateState.content).toBe(repair.content);
  });

  test('rechecks active owner and ASSISTANT identity on every read/write', async () => {
    const f = fixture(), pointer = await f.service.checkpoint(scope, source);
    f.tx.$queryRaw.mockResolvedValue([]);
    await expect(f.service.checkpoint(scope, source)).rejects.toThrow('普通AI会话');
    await expect(f.service.read(3, 4, pointer)).rejects.toThrow('普通AI会话');
    const sql = f.tx.$queryRaw.mock.calls.slice(0, 2).map(call => call[0].join('?')).join('\n');
    expect(sql).toContain("conversationType='ASSISTANT'");
    expect(sql).toContain("status='ACTIVE'");
    expect(sql.indexOf('FROM users')).toBeLessThan(sql.indexOf('FROM conversations'));
    expect(sql).toContain('userId=');
  });

  test('cross-owner/cross-conversation and running sources cannot be continued', async () => {
    const f = fixture(), pointer = await f.service.checkpoint(scope, source);
    await expect(f.service.read(3, 4, pointer)).rejects.toThrow('尚未结束');
    f.row.status = 'COMPLETED';
    await expect(f.service.read(8, 4, pointer)).rejects.toThrow('草稿不存在');
    await expect(f.service.read(3, 9, pointer)).rejects.toThrow('草稿不存在');
    expect(f.tx.chatRun.findFirst).toHaveBeenLastCalledWith({ where: {
      id, userId: 3, conversationId: 9, status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } }, select: { privateState: true } });
  });

  test('corrupt saved hash or incompatible private state is not reused or overwritten', async () => {
    const f = fixture(), pointer = await f.service.checkpoint(scope, source);
    f.row.privateState.hash = '0'.repeat(64);
    f.row.status = 'COMPLETED';
    await expect(f.service.read(3, 4, pointer)).rejects.toThrow('没有可继续');
    f.row.status = 'RUNNING';
    await expect(f.service.checkpoint(scope, source)).rejects.toThrow('未覆盖');
  });

  test('reuses task admission transaction rather than waiting on locks owned by itself', async () => {
    const f = fixture(), pointer = await f.service.checkpoint(scope, source);
    f.row.status = 'COMPLETED';
    f.prisma.$transaction.mockClear();
    expect(await f.service.read(3, 4, pointer, f.tx as any)).toMatchObject(pointer);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  test('validates safe paths, exact byte capacity, version pointers and credentials before persistence', async () => {
    const f = fixture();
    for (const snapshot of [
      { ...source, path: '../secret.html' }, { ...source, content: '中'.repeat(22000) },
      { ...source, content: 'a\0b' }, { ...source, content: 'sk-' + 'a'.repeat(30) },
      { ...source, reason: 'bad\nreason' }, { ...source, content: '' },
    ]) await expect(f.service.checkpoint(scope, snapshot)).rejects.toThrow();
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    await expect(f.service.read(3, 4, { draftId: '../bad', revision: 1, hash: '0'.repeat(64) })).rejects.toThrow('版本无效');
    await expect(f.service.read(3, 4, { draftId: id, revision: 0, hash: '0'.repeat(64) })).rejects.toThrow('版本无效');
  });
});
