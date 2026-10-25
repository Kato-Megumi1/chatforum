import { SkillExecutionContext, SkillTool } from './skill.interface';
import { ForumTool } from './forum-tool';

export class ForumTrackingSkill extends ForumTool {
  tool: SkillTool = {
    name: 'manage_forum_tracking',
    description: '持久管理当前用户论坛追踪。只有用户明确要求持续追踪/提醒、暂停、恢复或取消时才提议变更，服务端会暂停任务等待用户独立点击确认；普通查热帖/搜索绝不自动订阅。模型参数不能替代用户确认。不发送邮件，更新合并进站内通知，关闭聊天仍有效。先list查现有id，不猜ID。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list','create','pause','resume','remove'] },
      confirmed: { type: 'boolean', enum: [true], description: '仅旧客户端兼容，模型填写此值不授权任何写入；真实授权由独立操作确认界面完成，list无需' },
      id: { type: 'integer', minimum: 1 }, kind: { type: 'string', enum: ['NEW_POSTS','POST_ACTIVITY','HOT_RISE'] },
      categoryId: { type: 'integer', minimum: 1 }, postId: { type: 'integer', minimum: 1, description: 'POST_ACTIVITY必填，其他类型不填' },
      query: { type: 'string', minLength: 2, maxLength: 160 }, hours: { type: 'integer', enum: [24,168] },
      rankingBasis: { type: 'string', enum: ['published','interaction'] },
      cooldownSeconds: { type: 'integer', minimum: 60, maximum: 86400, description: '相同追踪的合并提醒窗口，默认3600秒' },
    }, required: ['action'] },
  };
  query(args: Record<string, any>, context: SkillExecutionContext) { return this.forum.tracking(args,context); }
}
