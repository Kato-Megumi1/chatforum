import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { SkillExecutionContext } from '../agent/skills/skill.interface';
import { codeArgs, codePath, codeText } from './coding.policy';
type Scope = { userId: number; conversationId: number };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const base = (s: Scope) => `local-code:v1:${s.userId}:${s.conversationId}`;
const pending = (id: string) => `local-code:operation:${id}`;
const receipt = (id: string) => `local-code:result:${id}`;

/** Browser RPC, not server filesystem access. Redis state expires, works across API/worker instances. */
@Injectable()
export class LocalWorkspaceService {
  constructor(private readonly db: PrismaService, private readonly redis: RedisService) {}
  private async owner(scope: Scope) {
    if (!await this.db.conversation.findFirst({ where: { id: scope.conversationId, userId: scope.userId,
      conversationType: 'ASSISTANT', user: { status: 'ACTIVE' } }, select: { id: true } })) throw new ForbiddenException('不能访问该工作区');
  }
  async connect(scope: Scope, name: string) {
    await this.owner(scope);
    if (await this.db.chatRun.count({ where: { ...scope, status: { in: ['QUEUED', 'RUNNING'] } } })) throw new ConflictException('请先停止任务再更换工作区');
    const token = randomBytes(32).toString('hex'), id = randomUUID();
    await this.redis.set(base(scope), JSON.stringify({ id, name, tokenHash: hash(token) }), 45);
    return { id, token, name };
  }
  async active(scope: Scope, id: string, token?: string) {
    await this.owner(scope);
    const raw = await this.redis.get(base(scope)), c = raw ? JSON.parse(raw) : null;
    if (!c || c.id !== id || (token !== undefined && hash(token) !== c.tokenHash)) throw new ConflictException('本机工作区已断开，请重新选择文件夹');
    return raw!;
  }
  private async liveRun(scope: Scope, op: any) {
    const run = await this.db.chatRun.findFirst({ where: { id: op.runId, ...scope, status: 'RUNNING' }, select: { input: true } });
    if (!run || (run.input as any)?.codingWorkspaceId !== op.workspaceId || Date.now() > op.expiresAt) throw new ConflictException('文件操作已取消或超时');
  }
  async poll(scope: Scope, id: string, token: string) {
    const raw = await this.active(scope, id, token);
    if (!await this.redis.compareReplace(base(scope), raw, raw, 45)) throw new ConflictException('工作区已更换');
    const value = await this.redis.get(pending(id));
    if (!value) return { operation: null };
    const op = JSON.parse(value);
    try { await this.liveRun(scope, op); } catch { await this.redis.compareDelete(pending(id), value); return { operation: null }; }
    return { operation: await this.redis.get(receipt(op.id)) ? null : op };
  }
  async authorize(scope: Scope, id: string, token: string, operationId: string) {
    await this.active(scope, id, token);
    const raw = await this.redis.get(pending(id));
    if (!raw || JSON.parse(raw).id !== operationId) throw new ConflictException('操作已过期');
    await this.liveRun(scope, JSON.parse(raw));
    return { authorized: true };
  }
  async complete(scope: Scope, id: string, token: string, operationId: string, result: unknown) {
    await this.authorize(scope, id, token, operationId);
    const value = JSON.stringify(result), key = receipt(operationId);
    if (Buffer.byteLength(value) > 100000) throw new ConflictException('操作结果过长');
    if (!await this.redis.getClient().set(key, value, 'EX', 75, 'NX') && await this.redis.get(key) !== value) throw new ConflictException('不能更改已提交的操作结果');
    return { received: true };
  }
  async disconnect(scope: Scope, id: string, token: string) {
    const raw = await this.active(scope, id, token);
    await this.redis.compareDelete(base(scope), raw);
    await this.redis.del(pending(id));
    return { disconnected: true };
  }
  async tool(input: unknown, context: SkillExecutionContext) {
    const { userId, conversationId, codingWorkspaceId: id, runId, signal } = context;
    if (!userId || !conversationId || !id || !runId) throw new ForbiddenException('缺少服务端工作区上下文');
    const scope = { userId, conversationId }, args = codeArgs.parse(input);
    if (args.path) codePath(args.path);
    if (args.content !== undefined) codeText(args.content);
    if (args.newText !== undefined) codeText(args.newText);
    if (args.action === 'propose') throw new ConflictException('本机工作区请read获取hash后用write直接修改，不使用云端propose');
    if (args.action === 'write' && (!args.path || !args.expectedHash)) throw new ConflictException('write需要path和expectedHash；新建用absent');
    await this.active(scope, id);
    const op = { id: randomUUID(), workspaceId: id, runId, args, expiresAt: Date.now() + 60000 }, raw = JSON.stringify(op);
    await this.liveRun(scope, op);
    if (!await this.redis.getClient().set(pending(id), raw, 'EX', 65, 'NX')) throw new ConflictException('已有文件操作，请稍后重试');
    try {
      while (Date.now() < op.expiresAt) {
        signal?.throwIfAborted();
        await this.active(scope, id); await this.liveRun(scope, op);
        const value = await this.redis.get(receipt(op.id));
        if (value) {
          const result = JSON.parse(value);
          if (!result.success) throw new ConflictException(result.error || '浏览器文件操作失败');
          return { workspace: 'local', operationId: op.id, ...result.data };
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new ConflictException('浏览器未确认操作；写入结果可能未知，请重新读取核对，不能假定成功或自动重写');
    } finally { await this.redis.compareDelete(pending(id), raw); await this.redis.del(receipt(op.id)); }
  }
}
