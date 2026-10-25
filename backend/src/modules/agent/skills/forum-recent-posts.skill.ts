import { SkillExecutionContext, SkillTool } from './skill.interface';
import { ForumTool, listFilters } from './forum-tool';

export class ForumRecentPostsSkill extends ForumTool {
  tool: SkillTool = {
    name: 'get_recent_posts',
    description: '按发布时间查询论坛最新帖子，默认全部历史，非24小时或30天。“看看最近七个帖子”用{limit:7,timeRange:"all"}，不传hours；“最近七天”才用{hours:168,timeRange:"window"}。支持分类/关键词和稳定翻页；sinceLastQuery查同会话同筛选上次查询后的新增，不声称后台监控。',
    parameters: { type: 'object', properties: { ...listFilters,
      sinceLastQuery: { type: 'boolean', description: '用户问“上次查询后有什么新增”时设true，默认false；不是未读数' },
    }, required: [] },
  };
  query(args: Record<string, any>, context: SkillExecutionContext) { return this.forum.list(args, context); }
}
