import { Global, Module, OnModuleInit } from '@nestjs/common';
import { SkillRegistry } from './skills';
import { WebSearchSkill } from './skills/web-search.skill';
import { WeatherSkill } from './skills/weather.skill';
import { CalculatorSkill } from './skills/calculator.skill';
import { DateTimeSkill } from './skills/datetime.skill';
import { KatoMegumiSkill } from './skills/kato-megumi.skill';
import { YukinoshitaYukinoSkill } from './skills/yukinoshita-yukino.skill';
import { ForumHotTopicsSkill } from './skills/forum-hot-topics.skill';
import { ForumRecentPostsSkill } from './skills/forum-recent-posts.skill';
import { ForumSearchSkill } from './skills/forum-search.skill';
import { ForumDetailSkill, ForumCategoriesSkill } from './skills/forum-detail.skill';
import { ForumDiscoveryService } from '../forum/forum-discovery.service';
import { AgentExecutorService } from './agent.executor';
import { RagService } from './rag.service';
import { PrismaService } from '../../common/prisma.service';
import { QdrantVectorService } from './qdrant-vector.service';
import { RagModelService } from './rag-model.service';
import { RagIndexService } from './rag-index.service';
import { NovelAnswerService } from './novel-answer.service';
import { NovelGraphService } from './novel-graph.service';
import { CharacterDialogueService } from './character-dialogue.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { CodingService } from '../coding/coding.service';
import { AttachmentService } from '../coding/attachment.service';
import { CodingSkill } from './skills/coding.skill';
import { LocalWorkspaceService } from '../coding/local-workspace.service';
import { AuthModule } from '../auth/auth.module';
import { ForumModule } from '../forum/forum.module';
import { ForumTrackingSkill } from './skills/forum-tracking.skill';
import { ArtifactReviewService } from '../coding/artifact-review.service';
import { FileDraftService } from '../coding/file-draft.service';
import { MemoryControlsService } from './memory-controls.service';
import { ToolRunModule } from '../tool-runs/tool-run.module';

@Global()
@Module({
  imports: [AuthModule, ForumModule, ToolRunModule],
  providers: [MemoryControlsService, FileDraftService, ArtifactReviewService, AttachmentService, LocalWorkspaceService, CodingService, ForumDiscoveryService, AgentExecutorService, RagService, PrismaService, QdrantVectorService, RagModelService, RagIndexService, NovelAnswerService, NovelGraphService, CharacterDialogueService, ConversationMemoryService],
  exports: [MemoryControlsService, FileDraftService, ArtifactReviewService, AttachmentService, LocalWorkspaceService, CodingService, AgentExecutorService, RagService, PrismaService, QdrantVectorService, RagModelService, RagIndexService, NovelAnswerService, CharacterDialogueService, ConversationMemoryService],
})
export class AgentModule implements OnModuleInit {
  constructor(private readonly forum: ForumDiscoveryService, private readonly coding: CodingService, private readonly local: LocalWorkspaceService,
    private readonly reviews: ArtifactReviewService) {}
  onModuleInit() {
    SkillRegistry.register(new ForumTrackingSkill(this.forum), { name: 'manage_forum_tracking', description: '论坛持续追踪与站内提醒', category: '论坛', enabled: true });
    SkillRegistry.register(new CodingSkill(this.coding, this.local, this.reviews), { name: 'code_workspace', description: '编程 Agent · 文件工作区', category: '编程', enabled: false });
    // Register all skills
    SkillRegistry.register(new WebSearchSkill(), {
      name: 'web_search',
      description: '搜索互联网获取最新信息',
      category: '信息检索',
      enabled: true,
    });

    SkillRegistry.register(new WeatherSkill(), {
      name: 'get_weather',
      description: '查询指定城市的天气信息',
      category: '生活工具',
      enabled: true,
    });

    SkillRegistry.register(new CalculatorSkill(), {
      name: 'calculator',
      description: '执行数学计算',
      category: '实用工具',
      enabled: true,
    });

    SkillRegistry.register(new DateTimeSkill(), {
      name: 'get_datetime',
      description: '获取当前日期和时间',
      category: '实用工具',
      enabled: true,
    });


    SkillRegistry.register(new KatoMegumiSkill(), {
      name: 'kato_megumi_persona',
      description: '加藤惠 — 平静温柔、不动声色的吐槽高手，路人女主',
      category: '角色扮演',
      enabled: false,
      isTool: false,
    });

    SkillRegistry.register(new YukinoshitaYukinoSkill(), {
      name: 'yukinoshita_yukino_persona',
      description: '雪之下雪乃 — 冰山美人、毒舌正直的侍奉部部长',
      category: '角色扮演',
      enabled: false,
      isTool: false,
    });

    SkillRegistry.register(new ForumHotTopicsSkill(this.forum), {
      name: 'get_hot_topics',
      description: '热帖排行与变化追踪（按需查询）',
      category: '论坛',
      enabled: true,
    });

    SkillRegistry.register(new ForumRecentPostsSkill(this.forum), {
      name: 'get_recent_posts',
      description: '新帖查询与上次查询后新增',
      category: '论坛',
      enabled: true,
    });

    SkillRegistry.register(new ForumSearchSkill(this.forum), {
      name: 'search_forum_posts',
      description: '搜索论坛帖子内容',
      category: '论坛',
      enabled: true,
    });
    SkillRegistry.register(new ForumDetailSkill(this.forum), {
      name: 'get_forum_post', description: '阅读帖子与最新评论', category: '论坛', enabled: true,
    });
    SkillRegistry.register(new ForumCategoriesSkill(this.forum), {
      name: 'get_forum_categories', description: '查询论坛分类', category: '论坛', enabled: true,
    });
  }
}
