import { SkillExecutionContext, SkillTool } from './skill.interface';
import { ForumTool } from './forum-tool';

export class ForumDetailSkill extends ForumTool {
  tool: SkillTool = {
    name: 'get_forum_post',
    description: '读取已查询帖子的正文片段及最新3条有效评论，承接“第二条说了什么/后续如何”。postId来自查询结果或用户明确指定；下一段用nextOffset，读取不刷浏览量。',
    parameters: { type: 'object', properties: {
      postId: { type: 'integer', minimum: 1, description: '真实帖子ID' },
      offset: { type: 'integer', minimum: 0, maximum: 50000, description: '正文字符偏移，首次0，后续使用nextOffset' },
    }, required: ['postId'] },
  };
  query(args: Record<string, any>, context: SkillExecutionContext) { return this.forum.detail(args, context); }
}
export class ForumCategoriesSkill extends ForumTool {
  tool: SkillTool = {
    name: 'get_forum_categories', description: '查询论坛分类名称与ID，不知道分类ID时先查，不臆造。',
    parameters: { type: 'object', properties: {}, required: [] },
  };
  query(_args: Record<string, any>, context: SkillExecutionContext) { return this.forum.categories(context); }
}
