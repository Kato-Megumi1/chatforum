import { SkillExecutionContext, SkillTool } from './skill.interface';
import { ForumTool, forumFilters } from './forum-tool';

export class ForumHotTopicsSkill extends ForumTool {
  tool: SkillTool = {
    name: 'get_hot_topics',
    description: '读取后台预计算热榜，支持24/168小时：published最近发布热门、interaction最近互动热帖。对比同会话上次榜单；snapshot未就绪不是没有帖子。持续订阅请使用manage_forum_tracking，单次查询不会自动订阅。',
    parameters: { type: 'object', properties: { ...forumFilters,
      rankingBasis: { type: 'string', enum: ['published','interaction'], description: 'published（默认）按发布时间窗口+累计互动；问最近讨论/活跃热帖用interaction，按窗口内净互动，可包含老帖。不混淆两个口径' },
      sortBy: { type: 'string', enum: ['hotness', 'views', 'likes', 'comments'], description: '综合热度（默认）/浏览/点赞/评论排序' },
    }, required: [] },
  };
  query(args: Record<string, any>, context: SkillExecutionContext) { return this.forum.hot(args, context); }
}
