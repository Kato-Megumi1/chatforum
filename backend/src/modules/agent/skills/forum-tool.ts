import { Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import { ForumDiscoveryService } from '../../forum/forum-discovery.service';
import { FORUM_DISCOVERY_VERSION } from '../../forum/forum-discovery.policy';
import { BaseSkill, SkillExecutionContext, SkillResult, SkillTool } from './skill.interface';

export const forumFilters = {
  hours: { type: 'integer', enum: [24,168], description: '后台预计算热榜支持24小时或168小时，默认168；其他明确窗口不可假装为已有榜单' },
  limit: { type: 'integer', minimum: 1, maximum: 20, description: '每页条数，默认5，最多20；优先少量结果，更多用游标' },
  categoryId: { type: 'integer', minimum: 1, description: '分类ID；不知道时用get_forum_categories查，不猜测' },
  category: { type: 'string', minLength: 1, maxLength: 50, description: '精确分类名称，可代替分类ID' },
  query: { type: 'string', minLength: 1, maxLength: 80, description: '标题/正文关键词，空格分隔最多8个必须包含的词；不把整句问题当关键词' },
};
export const listFilters = { ...forumFilters,
  hours: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: '仅用户指定时间时填写小时数，例如最近7天=168、90天=2160；省略表示全部历史，无30天上限。数量7条不能转换成7天或30天' },
  timeRange: { type: 'string', enum: ['all', 'window'], description: '最新/最近N条用all并省略hours；明确最近N天/小时用window并传hours。没有日期要求时默认all；不自动沿用上一轮空结果的时间限制' },
  sortOrder: { type: 'string', enum: ['asc', 'desc'], description: 'desc最新在前（默认）；asc时间线从早到晚' },
  includeTotal: { type: 'boolean', description: '默认false，不为取前几条扫描全站计数；只有明确需要数量时才设true，计数可能比列表慢' },
  cursor: { type: 'string', maxLength: 16003, description: '明确“下一页/继续这些结果”才传nextCursor或next，并保留原筛选。改问“最新7条”等新请求省略cursor，重新从最新查起；不能编造游标' },
};

export abstract class ForumTool extends BaseSkill {
  private readonly logger = new Logger('ForumTool');
  constructor(protected readonly forum: ForumDiscoveryService) { super(); }
  abstract tool: SkillTool;
  abstract query(args: Record<string, any>, context: SkillExecutionContext): Promise<unknown>;
  async execute(args: Record<string, any>, context: SkillExecutionContext): Promise<SkillResult> {
    context.signal?.throwIfAborted();
    // "next" resolves a mutable per-conversation checkpoint, not an immutable page.
    // Reusing the same raw-arguments memo entry would replay page two forever. Explicit
    // signed cursors remain idempotent and safe to coalesce within this task.
    if (args.cursor === 'next' || this.tool.name === 'manage_forum_tracking') return this.runQuery(args, context);
    const key = this.tool.name + ':' + JSON.stringify(args);
    if (context.forumMemo?.has(key)) return context.forumMemo.get(key)!;
    const pending = this.runQuery(args, context);
    context.forumMemo?.set(key, pending);
    try {
      const result = await pending;
      if (!result.success) context.forumMemo?.delete(key);
      return result;
    } catch (error) { context.forumMemo?.delete(key); throw error; }
  }
  private async runQuery(args: Record<string, any>, context: SkillExecutionContext): Promise<SkillResult> {
    try {
      const data = await this.query(args, context);
      context.signal?.throwIfAborted();
      for (const post of (data as any)?.posts || []) context.forumPostIds?.add(post.id);
      if ((data as any)?.post?.id) context.forumPostIds?.add((data as any).post.id);
      const result: SkillResult = { success: true, result: data, displayText: JSON.stringify(data),
        modelData: { trust: 'untrusted_forum_data', ...data as object } };
      return result;
    } catch (error) {
      context.signal?.throwIfAborted();
      const code = error instanceof ZodError ? 'INVALID_ARGUMENTS' : error instanceof Error &&
        ['INVALID_ARGUMENTS', 'INVALID_CURSOR', 'FORUM_ACCESS_DENIED', 'FORUM_ACTION_APPROVAL_REQUIRED', 'FORUM_POST_UNAVAILABLE', 'NO_NEXT_PAGE'].includes(error.message) ? error.message : 'FORUM_SERVICE_UNAVAILABLE';
      const message = { INVALID_ARGUMENTS: '参数不合法，请按工具定义调整；条数1～20。最新N条用timeRange=all，不传hours；window需正整数hours，列表查询没有30天上限。热帖时间单独限1～720小时；关键词不可为空。',
        INVALID_CURSOR: '翻页游标无效、过期或筛选已改变，请重新查询第一页。',
        NO_NEXT_PAGE: '该会话和筛选没有可继续的下一页；可重新查询或明确修改筛选条件。',
        FORUM_ACCESS_DENIED: '当前账号或会话无权访问，不能读取其他会话的追踪记录。',
        FORUM_ACTION_APPROVAL_REQUIRED: '此操作需要用户在普通AI会话的操作确认卡中单独确认，尚未执行。',
        FORUM_POST_UNAVAILABLE: '帖子不存在或目前不可公开读取。',
        FORUM_SERVICE_UNAVAILABLE: '论坛查询暂时失败，请稍后重试；这不表示没有帖子。' }[code];
      this.logger.warn(`${this.tool.name}: ${code}`);
      const data = { version: FORUM_DISCOVERY_VERSION, error: { code, message } };
      return { success: false, result: data, displayText: message, modelData: data };
    }
  }
}
