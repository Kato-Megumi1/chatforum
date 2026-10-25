import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import * as express from 'express';
import helmet from 'helmet';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { Server } from 'http';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { recordLogin } from '../../common/login-audit';
import { recordUsageSnapshot } from '../../common/usage-ledger';
import { AdminSettingsService, emailAddress } from '../admin-settings/admin-settings.service';
import { MailService } from '../admin-settings/mail.service';
import { ForumEventsService } from '../forum/forum-events.service';
import { ForumSearchIndexService } from '../forum/forum-search-index.service';
import { ForumReportsService } from '../forum/forum-reports.service';

const safeUser = { id: true, username: true, email: true, role: true, status: true, createdAt: true } as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const cookieName = 'cf_local_ops';
const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, path: '/ops-api', maxAge: 8 * 3600000 };
const problem = (status: number, message: string) => Object.assign(new Error(message), { status });
const aggregate = Prisma.sql`
 COALESCE(SUM(CASE WHEN m.kind='chat' THEN m.inputTokens ELSE 0 END),0) AS inputTokens,
 COALESCE(SUM(CASE WHEN m.kind='chat' THEN m.outputTokens ELSE 0 END),0) AS outputTokens,
 COALESCE(SUM(CASE WHEN m.kind='embedding' THEN m.inputTokens ELSE 0 END),0) AS embeddingTokens,
 COALESCE(SUM(COALESCE(m.inputTokens,0)+COALESCE(m.outputTokens,0)),0) AS totalTokens,
 COALESCE(SUM(m.cachedInputTokens),0) AS cachedInputTokens,
 COALESCE(SUM(m.reasoningTokens),0) AS reasoningTokens,
 COALESCE(SUM(m.callCount),0) AS calls,
 COALESCE(SUM(CASE WHEN m.inputTokens IS NULL OR m.outputTokens IS NULL THEN m.callCount ELSE 0 END),0) AS unreportedCalls,
 COALESCE(SUM(CASE WHEN m.quality='HISTORICAL_PARTIAL' THEN 1 ELSE 0 END),0) AS partialRecords,
 COALESCE(SUM(CASE WHEN m.costCny IS NULL THEN 1 ELSE 0 END),0) AS unpricedRecords,
 SUM(m.costCny) AS knownCostCny`;

export function windowStart(value: unknown) {
  const days = value === undefined ? 30 : Number(value);
  if (![0, 1, 7, 30, 90].includes(days)) throw problem(400, '时间范围无效');
  return days ? new Date(Date.now() - days * 86400000) : new Date(0);
}
function pagination(value: unknown) {
  const page = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(page) || page < 1 || page > 100000) throw problem(400, '页码无效');
  return { page, take: 25, skip: (page - 1) * 25 };
}
function optionalId(value: unknown) {
  if (value === undefined || value === '') return undefined;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw problem(400, '用户编号无效');
  return id;
}

@Injectable()
export class MonitorService implements OnApplicationBootstrap, OnModuleDestroy {
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private repairing = false;
  private readonly logger = new Logger(MonitorService.name);
  backfillState = 'pending';
  constructor(private readonly db: PrismaService, private readonly redis: RedisService,
    @Optional() private readonly settings?: AdminSettingsService, @Optional() private readonly mail?: MailService,
    @Optional() private readonly forumEvents?: ForumEventsService, @Optional() private readonly forumSearch?: ForumSearchIndexService,
    @Optional() private readonly forumReports?: ForumReportsService) {}

  async onApplicationBootstrap() {
    if (process.env.LOCAL_MONITOR_ENABLED !== 'true') return;
    const port = Number(process.env.LOCAL_MONITOR_PORT || 8091);
    const bind = process.env.LOCAL_MONITOR_BIND || '127.0.0.1';
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !['127.0.0.1', '0.0.0.0'].includes(bind))
      throw new Error('Invalid local monitor listener');
    // Docker requires an internal all-interface listener, but its host mapping MUST stay loopback.
    if (bind === '0.0.0.0' && process.env.LOCAL_MONITOR_CONTAINER !== 'true') throw new Error('Monitor external bind requires container isolation');
    const app = this.createApp(port);
    await new Promise<void>((resolve, reject) => { this.server = app.listen(port, bind, resolve); this.server.once('error', reject); });
    this.logger.log(`Local operations console ready on port ${port}`);
    void this.repairUsage();
    this.timer = setInterval(() => void this.repairUsage(), 300000); this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
  }

  createApp(port: number) {
    const app = express();
    app.disable('x-powered-by'); app.set('trust proxy', false);
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
    app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null,
      'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"], 'frame-ancestors': ["'none'"], 'form-action': ["'self'"] } },
      strictTransportSecurity: false }));
    app.use((req, res, next) => {
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      res.setHeader('Cache-Control', 'no-store');
      if (!allowed.includes(req.headers.host || '') || req.get('sec-fetch-site') === 'cross-site')
        return res.status(403).json({ message: '仅允许本机同源访问' });
      if (!['GET', 'HEAD'].includes(req.method) && req.get('origin') !== `http://${req.headers.host}`)
        return res.status(403).json({ message: '来源校验失败' });
      next();
    });
    app.use(express.json({ limit: '8kb', strict: true }));
    const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
      (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(fn(req, res)).catch(next);
    app.post('/ops-api/session', route(async (req, res) => {
      const password = req.body?.password, identity = req.body?.identity ?? req.body?.email;
      if (typeof identity !== 'string' || !identity.trim() || identity.length > 254 || /[\r\n\0]/.test(identity) || typeof password !== 'string' || password.length > 256)
        throw problem(400, '请输入管理员用户名或邮箱和密码');
      const normalized = identity.trim();
      await this.limitLogin(req.socket.remoteAddress || 'local', normalized);
      const user = await this.db.user.findUnique({ where: normalized.includes('@') ? { email: normalized } : { username: normalized } });
      const valid = user && await bcrypt.compare(password, user.password);
      const context = { ip: req.socket.remoteAddress, userAgent: req.get('user-agent') };
      if (!valid || user.status !== 'ACTIVE' || user.role !== 'ADMIN') {
        await recordLogin(this.db, user?.id ?? null, 'FAILED', 'LOCAL_ADMIN', context);
        throw problem(401, '管理员账号或密码不正确，或账号不可用');
      }
      const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
      const previous = this.readCookie(req);
      if (previous) await this.redis.del(`ops:session:${digest(previous)}`);
      await this.redis.set(`ops:session:${digest(token)}`, JSON.stringify({ userId: user.id, csrf, authVersion: user.authVersion }), 8 * 3600);
      await recordLogin(this.db, user.id, 'SUCCESS', 'LOCAL_ADMIN', context);
      res.cookie(cookieName, token, cookieOptions).json({ csrf, user: { id: user.id, username: user.username, role: user.role } });
    }));
    app.use('/ops-api', (req, res, next) => { void (async () => {
      const token = this.readCookie(req);
      const stored = token && await this.redis.get(`ops:session:${digest(token)}`);
      if (!stored) throw problem(401, '请登录本机管理页');
      const session = JSON.parse(stored);
      const user = await this.db.user.findUnique({ where: { id: session.userId }, select: { ...safeUser, authVersion: true } });
      if (!user || user.status !== 'ACTIVE' || user.role !== 'ADMIN') throw problem(403, '当前账号没有管理权限');
      if ((session.authVersion ?? 0) !== user.authVersion) {
        await this.redis.del(`ops:session:${digest(token)}`);
        res.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', path: '/ops-api' });
        throw problem(401, '密码已修改，请重新登录本机管理页');
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.get('x-ops-csrf') !== session.csrf) throw problem(403, '请求校验失败，请刷新页面');
      const { authVersion: _version, ...publicUser } = user;
      res.locals.actor = publicUser; res.locals.actorVersion = user.authVersion; res.locals.csrf = session.csrf; res.locals.token = token;
      next();
    })().catch(next); });
    const api = express.Router();
    api.get('/me', route(async (_req, res) => { res.json({ user: res.locals.actor, csrf: res.locals.csrf }); }));
    api.delete('/session', route(async (_req, res) => {
      await this.redis.del(`ops:session:${digest(res.locals.token)}`);
      res.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', path: '/ops-api' }).json({ ok: true });
    }));
    api.get('/summary', route(async (req, res) => { res.json(await this.summary(windowStart(req.query.days))); }));
    api.get('/settings', route(async (_req, res) => { res.json(this.settings?.snapshot() || { unavailable: true }); }));
    api.put('/settings/smtp', route(async (req, res) => {
      if (!this.settings || !this.mail) throw problem(503, '配置服务未就绪');
      if (req.body?.enabled) await this.mail.validateHost(req.body.host);
      await this.adminAudit(res.locals.actor.id, 'SMTP_SETTINGS_ATTEMPT', { enabled: req.body?.enabled === true }, req.socket.remoteAddress);
      const result = await this.settings.saveSmtp(req.body);
      await this.adminAudit(res.locals.actor.id, 'SMTP_SETTINGS_SAVED', { enabled: result.smtp.enabled, passwordConfigured: result.smtp.passwordConfigured }, req.socket.remoteAddress);
      res.json(result);
    }));
    api.put('/settings/models', route(async (req, res) => {
      if (!this.settings) throw problem(503, '配置服务未就绪');
      await this.adminAudit(res.locals.actor.id, 'MODEL_SETTINGS_ATTEMPT', {}, req.socket.remoteAddress);
      const result = await this.settings.saveModels(req.body);
      await this.adminAudit(res.locals.actor.id, 'MODEL_SETTINGS_SAVED', result.models.enabled, req.socket.remoteAddress);
      res.json(result);
    }));
    api.post('/settings/smtp/test', route(async (req, res) => {
      if (!this.mail) throw problem(503, '邮件服务未就绪');
      if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !emailAddress(req.body.to))
        throw problem(400, '请输入一个有效的测试收件邮箱；测试不接受自定义标题、内容或多个收件人');
      if (!await this.mail.isReady()) throw problem(503, '请先保存并启用邮件配置，再发送测试邮件');
      const retryAfter = await this.smtpTestRetryAfter(res.locals.actor.id);
      if (retryAfter) {
        res.setHeader('Retry-After', String(retryAfter));
        throw problem(429, `测试发送过于频繁，请${retryAfter}秒后重试`);
      }
      const details = { recipientHash: digest(req.body.to.toLowerCase()) };
      await this.adminAudit(res.locals.actor.id, 'SMTP_TEST_ATTEMPT', details, req.socket.remoteAddress);
      const result = await this.mail.sendTest(req.body.to);
      await this.adminAudit(res.locals.actor.id, 'SMTP_TEST_ACCEPTED', details, req.socket.remoteAddress);
      res.json(result);
    }));
    api.get('/posts', route(async (req, res) => { res.json(await this.businessPosts(req.query)); }));
    api.get('/reports', route(async (req, res) => {
      if(!this.forumReports)throw problem(503,'举报服务尚未就绪');
      res.json(await this.forumReports.adminList(res.locals.actor.id,res.locals.actorVersion,'reports',req.query));
    }));
    api.get('/report-appeals', route(async (req, res) => {
      if(!this.forumReports)throw problem(503,'举报服务尚未就绪');
      res.json(await this.forumReports.adminList(res.locals.actor.id,res.locals.actorVersion,'appeals',req.query));
    }));
    api.post('/reports/:id/decision', route(async (req, res) => {
      if(!this.forumReports)throw problem(503,'举报服务尚未就绪');
      res.json(await this.forumReports.decide(res.locals.actor.id,res.locals.actorVersion,optionalId(req.params.id),req.body,req.socket.remoteAddress));
    }));
    api.get('/reports/:id/context', route(async (req, res) => {
      if(!this.forumReports)throw problem(503,'举报服务尚未就绪');
      res.json(await this.forumReports.context(res.locals.actor.id,res.locals.actorVersion,optionalId(req.params.id)));
    }));
    api.post('/report-appeals/:id/decision', route(async (req, res) => {
      if(!this.forumReports)throw problem(503,'举报服务尚未就绪');
      res.json(await this.forumReports.decideAppeal(res.locals.actor.id,res.locals.actorVersion,optionalId(req.params.id),req.body,req.socket.remoteAddress));
    }));
    api.get('/forum-pipeline', route(async (_req, res) => { res.json({ events: await this.forumEvents?.diagnostics(), search: await this.forumSearch?.status() }); }));
    api.post('/forum-pipeline/retry', route(async (req, res) => {
      const consumer = req.body?.consumer;
      if (!this.forumEvents || !['forum-projections-v1','forum-search-v1','forum-subscriptions-v1'].includes(consumer)
        || req.body?.confirmation !== consumer) throw problem(400, '请确认要重试的投递消费者');
      const updated = await this.forumEvents.retryDead(consumer,50);
      await this.adminAudit(res.locals.actor.id, 'FORUM_DELIVERY_RETRY', { consumer, updated }, req.socket.remoteAddress);
      res.json({ ok: true, updated });
    }));
    api.post('/forum-search/build', route(async (req, res) => {
      if (!this.forumSearch || req.body?.confirmation !== 'BUILD_FORUM_SEARCH') throw problem(400, '请确认构建独立论坛搜索索引');
      const result = await this.forumSearch.startBuild({ confirmation: 'BUILD_FORUM_SEARCH' });
      await this.adminAudit(res.locals.actor.id, 'FORUM_SEARCH_BUILD', { buildId: result.id }, req.socket.remoteAddress);
      res.json({ id: result.id, status: result.status, postCursor: result.postCursor, maxPostId: result.maxPostId });
    }));
    api.post('/forum-search/:id/validate', route(async (req, res) => {
      if (!this.forumSearch || req.body?.confirmation !== req.params.id) throw problem(400, '请确认搜索构建编号');
      const result = await this.forumSearch.validateBuild(req.params.id);
      await this.adminAudit(res.locals.actor.id, 'FORUM_SEARCH_VALIDATE', { buildId: result.id }, req.socket.remoteAddress);
      res.json({ id: result.id, status: result.status, expectedCount: result.expectedCount });
    }));
    api.post('/forum-search/:id/publish', route(async (req, res) => {
      if (!this.forumSearch || req.body?.confirmation !== req.params.id) throw problem(400, '请确认搜索发布编号');
      const result = await this.forumSearch.publish(req.params.id, { confirmation: req.params.id });
      await this.adminAudit(res.locals.actor.id, 'FORUM_SEARCH_PUBLISH', { buildId: req.params.id }, req.socket.remoteAddress);
      res.json({ id: result.id, status: result.status });
    }));
    api.patch('/posts/:id/status', route(async (req, res) => { res.json(await this.moderatePost(res.locals.actor.id, optionalId(req.params.id), req.body, req.socket.remoteAddress)); }));
    api.get('/comments', route(async (req, res) => { res.json(await this.businessComments(req.query)); }));
    api.patch('/comments/:id/status', route(async (req, res) => { res.json(await this.moderateComment(res.locals.actor.id, optionalId(req.params.id), req.body, req.socket.remoteAddress)); }));
    api.get('/knowledge-bases', route(async (req, res) => { res.json(await this.businessKnowledgeBases(req.query)); }));
    api.get('/users', route(async (req, res) => { res.json(await this.users(req.query)); }));
    api.get('/logins', route(async (req, res) => {
      const p = pagination(req.query.page), outcome = req.query.outcome;
      if (outcome && !['SUCCESS', 'FAILED', 'REGISTERED'].includes(String(outcome))) throw problem(400, '登录状态无效');
      const where = { createdAt: { gte: windowStart(req.query.days) }, userId: optionalId(req.query.userId), ...(outcome ? { outcome: String(outcome) } : {}) };
      res.json({ ...p, total: await this.db.loginEvent.count({ where }), rows: await this.db.loginEvent.findMany({ where,
        take: p.take, skip: p.skip, orderBy: { id: 'desc' }, include: { user: { select: { id: true, username: true } } } }) });
    }));
    api.get('/usage', route(async (req, res) => {
      const p = pagination(req.query.page);
      const where = { createdAt: { gte: windowStart(req.query.days) }, userId: optionalId(req.query.userId) };
      res.json({ ...p, total: await this.db.modelUsageEntry.count({ where }), rows: await this.db.modelUsageEntry.findMany({ where,
        take: p.take, skip: p.skip, orderBy: { id: 'desc' }, include: { user: { select: { id: true, username: true } } } }) });
    }));
    api.get('/failures', route(async (req, res) => {
      const p = pagination(req.query.page), where = { status: { in: ['FAILED', 'CANCELLED'] }, createdAt: { gte: windowStart(req.query.days) } };
      const rows = await this.db.chatRun.findMany({ where, take: p.take, skip: p.skip, orderBy: { createdAt: 'desc' },
        select: { id: true, userId: true, status: true, createdAt: true, updatedAt: true } });
      res.json({ ...p, total: await this.db.chatRun.count({ where }), rows });
    }));
    api.get('/audit', route(async (req, res) => {
      const p = pagination(req.query.page), where = { module: 'LOCAL_MONITOR', createdAt: { gte: windowStart(req.query.days) } };
      res.json({ ...p, total: await this.db.operationLog.count({ where }), rows: await this.db.operationLog.findMany({ where,
        take: p.take, skip: p.skip, orderBy: { id: 'desc' }, include: { user: { select: { id: true, username: true } } } }) });
    }));
    api.patch('/users/:id/status', route(async (req, res) => {
      res.json(await this.setStatus(res.locals.actor.id, optionalId(req.params.id), req.body, req.socket.remoteAddress));
    }));
    app.use('/ops-api', api);
    app.use('/ops-api', (_req, res) => { res.status(404).json({ message: '接口不存在' }); });
    app.use(express.static(join(process.cwd(), 'monitor-public'), { dotfiles: 'deny', etag: false, maxAge: 0 }));
    app.use((_req, res) => { res.status(404).send('Not found'); });
    app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = [400, 401, 403, 404, 409, 413, 429, 503].includes(error.status || error.getStatus?.()) ? (error.status || error.getStatus()) : 500;
      if (status === 500) this.logger.error('Local monitor request failed');
      res.status(status).json({ message: status === 500 ? '管理服务暂不可用，请稍后重试' : error.message });
    });
    return app;
  }

  private readCookie(req: express.Request) {
    return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1).match(/^[a-f0-9]{64}$/)?.[0];
  }
  private async adminAudit(actor: number, action: string, details: object, ip?: string) {
    await this.db.operationLog.create({ data: { userId: actor, module: 'LOCAL_MONITOR', action,
      details: JSON.stringify(details), ip: ip?.slice(0, 64) } });
  }
  async businessPosts(query: express.Request['query']) {
    const p = pagination(query.page), status = String(query.status || ''), q = String(query.q || '').trim().slice(0, 100);
    if (status && !['PENDING', 'APPROVED', 'REJECTED'].includes(status)) throw problem(400, '帖子状态无效');
    const where: Prisma.PostWhereInput = { ...(status ? { status: status as any } : {}), ...(q ? { title: { contains: q } } : {}) };
    const [rows, total] = await Promise.all([this.db.post.findMany({ where, take: p.take, skip: p.skip, orderBy: { id: 'desc' },
      select: { id: true, title: true, status: true, revision: true, createdAt: true, viewCount: true, commentCount: true, user: { select: { id: true, username: true } } } }), this.db.post.count({ where })]);
    return { ...p, total, rows };
  }
  async moderatePost(actor: number, id: number, body: any, ip?: string) {
    if (!id || !['PENDING', 'APPROVED', 'REJECTED'].includes(body?.status) || !['PENDING', 'APPROVED', 'REJECTED'].includes(body?.expectedStatus) ||
      !Number.isSafeInteger(body.expectedRevision) || typeof body.confirmation !== 'string') throw problem(400, '帖子审核参数无效');
    if (body.status === body.expectedStatus) throw problem(400, '帖子状态没有变化，无需重复发布');
    return this.db.$transaction(async tx => {
      const administrator = await tx.user.findFirst({ where: { id: actor, status: 'ACTIVE', role: 'ADMIN' }, select: { id: true } });
      if (!administrator) throw problem(403, '当前账号没有管理权限');
      const target = await tx.post.findUnique({ where: { id }, select: { title: true, status: true, revision: true } });
      if (!target) throw problem(404, '帖子不存在');
      if (target.title !== body.confirmation) throw problem(400, '确认帖子标题不匹配');
      const changed = await tx.post.updateMany({ where: { id, status: body.expectedStatus, revision: body.expectedRevision }, data: { status: body.status, revision: { increment: 1 } } });
      if (!changed.count) throw problem(409, '帖子已发生变化，请刷新后操作');
      await this.forumEvents?.append(tx, { kind: body.status === 'APPROVED' ? 'POST_APPROVED' : 'POST_HIDDEN', postId: id,
        postRevision: body.expectedRevision + 1, actorId: actor, payload: { status: body.status, previousStatus: target.status } });
      await tx.operationLog.create({ data: { userId: actor, module: 'LOCAL_MONITOR', action: 'POST_MODERATION',
        details: JSON.stringify({ postId: id, from: target.status, to: body.status }), ip: ip?.slice(0, 64) } });
      return { ok: true };
    });
  }
  async businessComments(query: express.Request['query']) {
    const p = pagination(query.page), status = String(query.status || ''), postId = optionalId(query.postId);
    if (status && !['ACTIVE', 'DELETED'].includes(status)) throw problem(400, '评论状态无效');
    const where: Prisma.CommentWhereInput = { ...(status ? { status: status as any } : {}), ...(postId ? { postId } : {}) };
    const [rows, total] = await Promise.all([this.db.comment.findMany({ where, take: p.take, skip: p.skip, orderBy: { id: 'desc' },
      select: { id: true, content: true, status: true, postId: true, parentId: true, createdAt: true, user: { select: { id: true, username: true } }, post: { select: { id: true, title: true } } } }), this.db.comment.count({ where })]);
    return { ...p, total, rows: rows.map(c => ({ ...c, content: c.content.slice(0, 500) })) };
  }
  async moderateComment(actor: number, id: number, body: any, ip?: string) {
    if (!id || !['ACTIVE', 'DELETED'].includes(body?.status) || !['ACTIVE', 'DELETED'].includes(body?.expectedStatus) || body.confirmation !== String(id))
      throw problem(400, '评论审核参数或确认编号无效');
    const comment = await this.db.comment.findUnique({ where: { id }, select: { postId: true } });
    if (!comment) throw problem(404, '评论不存在');
    return this.db.$transaction(async tx => {
      if (!await tx.user.findFirst({ where: { id: actor, status: 'ACTIVE', role: 'ADMIN' }, select: { id: true } })) throw problem(403, '当前账号没有管理权限');
      // Lock post before comment, matching public create/delete and keeping counters consistent.
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${comment.postId} FOR UPDATE`;
      const changed = await tx.comment.updateMany({ where: { id, status: body.expectedStatus }, data: { status: body.status } });
      if (!changed.count) throw problem(409, '评论状态已改变，请刷新后操作');
      if (body.status !== body.expectedStatus) await tx.post.update({ where: { id: comment.postId }, data: {
        commentCount: body.status === 'ACTIVE' ? { increment: 1 } : { decrement: 1 } } });
      if (body.status !== body.expectedStatus) {
        const post = await tx.post.findUniqueOrThrow({ where: { id: comment.postId }, select: { revision: true } });
        await this.forumEvents?.append(tx, { kind: body.status === 'ACTIVE' ? 'COMMENT_RESTORED' : 'COMMENT_DELETED', postId: comment.postId,
          postRevision: post.revision, actorId: actor, payload: { commentId: id, delta: { comments: body.status === 'ACTIVE' ? 1 : -1 } } });
      }
      await tx.operationLog.create({ data: { userId: actor, module: 'LOCAL_MONITOR', action: 'COMMENT_MODERATION',
        details: JSON.stringify({ commentId: id, from: body.expectedStatus, to: body.status }), ip: ip?.slice(0, 64) } });
      return { ok: true };
    });
  }
  async businessKnowledgeBases(query: express.Request['query']) {
    const p = pagination(query.page);
    const [rows, total] = await Promise.all([this.db.knowledgeBase.findMany({ take: p.take, skip: p.skip, orderBy: { id: 'desc' },
      select: { id: true, name: true, visibility: true, ownerId: true, activeIndexVersion: true, _count: { select: { documents: true } } } }), this.db.knowledgeBase.count()]);
    const ids = rows.map(k => k.id);
    const sizes = ids.length ? await this.db.knowledgeBaseDocument.groupBy({ by: ['knowledgeBaseId'], where: { knowledgeBaseId: { in: ids }, isCurrent: true, isDeleted: false },
      _sum: { fileSize: true, chunkCount: true }, _count: true }) : [];
    return { ...p, total, rows: rows.map(k => { const size = sizes.find(s => s.knowledgeBaseId === k.id); return {
      id: k.id, name: k.name, visibility: k.visibility, ownerId: k.ownerId, indexVersion: k.activeIndexVersion,
      status: k.activeIndexVersion ? 'ACTIVE' : 'UNPUBLISHED', documentCount: size?._count || 0, totalBytes: size?._sum.fileSize || 0, chunkCount: size?._sum.chunkCount || 0 }; }) };
  }
  private async smtpTestRetryAfter(actor: number): Promise<number> {
    // Atomic across sessions/workers. Rejected requests do not extend the cooldown;
    // failed SMTP attempts still consume it to prevent credential probing/spam.
    const script = `
      local cooldown=redis.call('PTTL',KEYS[1])
      if cooldown>0 then return cooldown end
      if tonumber(redis.call('GET',KEYS[2]) or '0')>=5 then return math.max(1,redis.call('PTTL',KEYS[2])) end
      if tonumber(redis.call('GET',KEYS[3]) or '0')>=20 then return math.max(1,redis.call('PTTL',KEYS[3])) end
      redis.call('SET',KEYS[1],'1','PX',60000)
      local own=redis.call('INCR',KEYS[2]); if own==1 then redis.call('PEXPIRE',KEYS[2],600000) end
      local total=redis.call('INCR',KEYS[3]); if total==1 then redis.call('PEXPIRE',KEYS[3],600000) end
      return 0`;
    try {
      const wait = Number(await this.redis.getClient().eval(script, 3,
        `ops:smtp-test:cooldown:${actor}`, `ops:smtp-test:window:${actor}`, 'ops:smtp-test:window:all'));
      if (!Number.isFinite(wait) || wait < 0) throw Error('Invalid limiter result');
      return Math.ceil(wait / 1000);
    } catch { throw problem(503, '邮件测试限流服务暂不可用，请稍后重试'); }
  }

  private async limitLogin(ip: string, email: string) {
    for (const key of [`ops:login:ip:${digest(ip)}`, `ops:login:account:${digest(email.toLowerCase())}`]) {
      const n = await this.redis.getClient().eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],300) end; return n", 1, key);
      if (Number(n) > 10) throw problem(429, '尝试过于频繁，请五分钟后再试');
    }
  }

  async summary(start: Date) {
    const [totals, models, daily, users, banned, logins, failedLogins, tasks, uncovered, firstLogin] = await Promise.all([
      this.db.$queryRaw<any[]>`SELECT ${aggregate} FROM model_usage_entries m WHERE m.createdAt >= ${start}`,
      this.db.$queryRaw`SELECT m.model, m.kind, ${aggregate} FROM model_usage_entries m WHERE m.createdAt >= ${start} AND m.kind<>'none' GROUP BY m.model,m.kind ORDER BY totalTokens DESC`,
      this.db.$queryRaw`SELECT DATE_FORMAT(DATE_ADD(m.createdAt,INTERVAL 8 HOUR),'%Y-%m-%d') AS day, ${aggregate} FROM model_usage_entries m WHERE m.createdAt >= ${start} GROUP BY day ORDER BY day`,
      this.db.user.count(), this.db.user.count({ where: { status: { not: 'ACTIVE' } } }),
      this.db.loginEvent.count({ where: { createdAt: { gte: start }, outcome: { in: ['SUCCESS', 'REGISTERED'] }, channel: 'WEB' } }),
      this.db.loginEvent.count({ where: { createdAt: { gte: start }, outcome: 'FAILED' } }),
      this.db.chatRun.groupBy({ by: ['status'], where: { createdAt: { gte: start } }, _count: true }),
      this.db.$queryRaw<any[]>`SELECT COUNT(*) AS n FROM chat_runs r WHERE r.status IN ('COMPLETED','FAILED','CANCELLED') AND r.createdAt>=${start}
        AND NOT EXISTS (SELECT 1 FROM model_usage_entries m WHERE m.scope='CHAT' AND m.sourceId=r.id)`,
      this.db.loginEvent.findFirst({ orderBy: { id: 'asc' }, select: { createdAt: true } }),
    ]);
    return { totals: totals[0], models, daily, users, banned, logins, failedLogins, tasks,
      untrackedTasks: Number(uncovered[0].n), loginTrackingSince: firstLogin?.createdAt ?? null, backfill: this.backfillState, generatedAt: new Date() };
  }
  async users(query: express.Request['query']) {
    const p = pagination(query.page), start = windowStart(query.days), q = String(query.q || '').trim().slice(0, 100), status = String(query.status || '');
    if (status && !['ACTIVE', 'INACTIVE', 'BANNED'].includes(status)) throw problem(400, '账号状态无效');
    const where: Prisma.UserWhereInput = { ...(status ? { status: status as any } : {}),
      ...(q ? { OR: [{ username: { contains: q } }, { email: { contains: q } }, ...(Number.isSafeInteger(Number(q)) ? [{ id: Number(q) }] : [])] } : {}) };
    const rows = await this.db.user.findMany({ where, select: safeUser, orderBy: { id: 'desc' }, take: p.take, skip: p.skip });
    const ids = rows.map(r => r.id);
    const usage = ids.length ? await this.db.$queryRaw<any[]>`SELECT m.userId, ${aggregate} FROM model_usage_entries m
      WHERE m.userId IN (${Prisma.join(ids)}) AND m.createdAt >= ${start} GROUP BY m.userId` : [];
    const last = ids.length ? await this.db.loginEvent.groupBy({ by: ['userId'], where: { userId: { in: ids }, channel: 'WEB', outcome: { in: ['SUCCESS', 'REGISTERED'] } }, _max: { createdAt: true } }) : [];
    return { ...p, total: await this.db.user.count({ where }), rows: rows.map(user => ({ ...user,
      usage: usage.find(r => r.userId === user.id) || null, lastLoginAt: last.find(r => r.userId === user.id)?._max.createdAt || null })) };
  }
  async setStatus(actor: number, id: number, body: any, ip?: string) {
    if (!id || !['ACTIVE', 'BANNED'].includes(body?.status) || !['ACTIVE', 'INACTIVE', 'BANNED'].includes(body?.expectedStatus) || typeof body?.confirmation !== 'string')
      throw problem(400, '账号变更参数无效');
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${id} FOR UPDATE`;
      const target = await tx.user.findUnique({ where: { id }, select: safeUser });
      if (!target) throw problem(404, '账号不存在');
      if (target.id === actor || target.role === 'ADMIN') throw problem(403, '本页不允许禁用或变更管理员账号');
      if (target.status !== body.expectedStatus) throw problem(409, '账号状态已改变，请刷新后操作');
      if (body.confirmation !== target.username) throw problem(400, '确认用户名不匹配');
      if (target.status === body.status) return;
      await tx.user.update({ where: { id }, data: { status: body.status } });
      await tx.operationLog.create({ data: { userId: actor, module: 'LOCAL_MONITOR', action: 'ACCOUNT_STATUS',
        details: JSON.stringify({ targetUserId: id, from: target.status, to: body.status }), ip: ip?.slice(0, 64) } });
    });
    // DB status is checked by the public JWT guard on every request. Refresh also checks it.
    let refreshRevoked = true;
    if (body.status === 'BANNED') { try { await this.redis.del(`refresh_token:${id}`); } catch { refreshRevoked = false; } }
    return { ok: true, refreshRevoked };
  }
  async repairUsage() {
    if (this.repairing || this.stopped) return;
    this.repairing = true; this.backfillState = 'running';
    try {
      const migration = await this.db.$queryRaw<any[]>`SELECT finished_at FROM _prisma_migrations WHERE migration_name='202609220002_local_monitor' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`;
      const legacyCutoff = migration[0]?.finished_at || new Date(0);
      let cursor: string | undefined;
      while (!this.stopped) {
        const rows = await this.db.chatRun.findMany({ where: { status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
          orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, userId: true, createdAt: true, usage: true, result: true } });
        if (!rows.length) break;
        for (const row of rows) {
          // New runs persist the full runtime, not the RAG sub-chain. Never backfill
          // a partial result while its completion callback is still writing usage.
          const usage = row.usage || (row.createdAt < legacyCutoff ? (row.result as any)?.ragMetadata?.usage : null);
          await recordUsageSnapshot(this.db, { scope: 'CHAT', sourceId: row.id, userId: row.userId, createdAt: row.createdAt }, usage);
        }
        cursor = rows.at(-1)!.id;
      }
      let indexCursor = 0;
      while (!this.stopped) {
        const rows = await this.db.ragIndexVersion.findMany({ where: { id: { gt: indexCursor }, status: { not: 'BUILDING' } }, orderBy: { id: 'asc' }, take: 50,
          select: { id: true, createdAt: true, metrics: true, manifest: true } });
        if (!rows.length) break;
        for (const row of rows) await recordUsageSnapshot(this.db, { scope: 'INDEX', sourceId: String(row.id), createdAt: row.createdAt,
          userId: Number.isInteger((row.manifest as any)?.requestedBy) ? (row.manifest as any).requestedBy : null }, (row.metrics as any)?.usage);
        indexCursor = rows.at(-1)!.id;
      }
      this.backfillState = 'complete';
    } catch { this.backfillState = 'failed'; this.logger.error('Historical usage repair failed; will retry'); }
    finally { this.repairing = false; }
  }
}
