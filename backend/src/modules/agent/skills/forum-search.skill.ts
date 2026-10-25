import { SkillExecutionContext, SkillTool } from './skill.interface';
import { ForumTool, listFilters } from './forum-tool';

export class ForumSearchSkill extends ForumTool {
  tool: SkillTool = {
    name: 'search_forum_posts',
    description: '关键词查询论坛，默认全部历史，可缩小时间范围、筛分类、按时间线排序和游标翻页。返回命中位置附近摘录；全文/后续评论用get_forum_post，不根据标题编故事。',
    parameters: { type: 'object', properties: listFilters, required: ['query'] },
  };
  query(args: Record<string, any>, context: SkillExecutionContext) { return this.forum.list(args, context, true); }
}
