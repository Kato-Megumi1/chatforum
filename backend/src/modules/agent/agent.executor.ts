import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { attachForumLinks } from '../forum/forum-answer-links';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  BaseMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createOpenAIToolsAgent, AgentExecutor } from 'langchain/agents';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate,
} from '@langchain/core/prompts';
import { SkillRegistry, SkillResult, BaseSkill } from './skills';
import { PrismaService } from '../../common/prisma.service';
import { meteredFetch, RuntimeUsage, runtimeState, setModelStage, withPublicActivity, PublicModelActivity } from './model-runtime';
import { positiveSetting } from './context-budget';
import { SkillExecutionContext } from './skills/skill.interface';
import { FORUM_TOOL_RULE } from './skills/forum-output';
import { CODING_RULE } from '../coding/coding.policy';
import { providerToolReasoningFetch } from './provider-tool-reasoning';
import { WEB_SEARCH_RULE } from './skills/web-search.skill';
import { extractToolOutputs } from './agent-tool-results';
import { AgentToolLoopIncompleteError } from './model-output.error';
import { ToolRunService } from '../tool-runs/tool-run.service';
import { CodingService } from '../coding/coding.service';
import { restoreToolFileReceipt } from '../coding/tool-file-receipt';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  // Server-resolved, normalized attachments only. Never taken from client chat JSON.
  images?: Array<{ path: string; url: string }>;
  reasoning_content?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentExecuteOptions {
  messages: AgentMessage[];
  apiKey: string;
  apiBase: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  enabledSkills?: string[];
  systemPrompt?: string;
  extraTools?: DynamicStructuredTool[];
}

@Injectable()
export class AgentExecutorService {
  private readonly logger = new Logger(AgentExecutorService.name);

  constructor(private readonly prismaService: PrismaService, @Optional() private readonly toolRuns?: ToolRunService,
    @Optional() private readonly coding?: CodingService) {}

  /**
   * Execute agent with tools using LangChain.
   * Maintains backward compatibility with the previous fetch-based implementation.
   */
  async executeWithTools(
    messages: AgentMessage[],
    apiKey: string,
    apiBase: string,
    model: string,
    temperature?: number,
    maxTokens?: number,
    enabledSkills?: string[],
    systemPrompt?: string,
    extraTools?: DynamicStructuredTool[],
    modelKwargs?: Record<string, unknown>,
    delivery?: { onToken: (text: string) => Promise<void>; signal: AbortSignal },
    usage?: RuntimeUsage,
    skillContext: SkillExecutionContext = {},
  ): Promise<{ content: string; toolOutputs: SkillResult[]; reasoningContent?: string }> {
    const deepThinking = modelKwargs?.enable_thinking === true || (modelKwargs?.thinking as any)?.type === 'enabled';
    const timeout = deepThinking ? 180000 : 60000;
    const provider = providerToolReasoningFetch(meteredFetch(usage, delivery?.signal, timeout));
    try {
    // 1. Create LLM instance
    const llm = new ChatOpenAI({
      apiKey,
      timeout,
      maxRetries: 0,
      streamUsage: true,
      configuration: {
        baseURL: apiBase,
        fetch: provider.fetch,
      },
      model,
      modelKwargs,
      temperature: temperature ?? 0.7,
      ...(maxTokens ? { maxTokens } : {}),
    });

    // 2. Get LangChain tools from skill registry + any extra tools (e.g. RAG)
    const context: SkillExecutionContext = { ...skillContext,
      artifactReviews:skillContext.artifactReviews || [],artifactReviewAttempts:skillContext.artifactReviewAttempts || new Map(),
      signal: runtimeState()?.signal || delivery?.signal, forumMemo: new Map(), forumPostIds: new Set() };
    const tools = [
      ...SkillRegistry.getLangChainTools(enabledSkills, this.prismaService, context),
      ...(extraTools || []),
    ].map(tool => new DynamicStructuredTool({
      name: tool.name, description: tool.description, schema: tool.schema as any,
      func: async (input: any, _manager: any, config: any) => {
        runtimeState()?.signal.throwIfAborted();
        setModelStage('tools');
        const activity: PublicModelActivity | undefined = tool.name === 'web_search' ? 'web_search' :
          tool.name === 'code_workspace' ? input?.action === 'propose' ? 'save_file' : 'read_files' :
          ['get_hot_topics', 'get_recent_posts', 'search_forum_posts', 'get_forum_post', 'get_forum_categories'].includes(tool.name) ? 'forum_search' : undefined;
        const actual = (args:Record<string,unknown>) => tool.invoke(args, { ...config, signal: runtimeState()?.signal || delivery?.signal });
        const invoke = () => this.toolRuns && context.runId ? this.toolRuns.invoke(tool.name,input,context,
          async args => {const result=await actual(args);return typeof result==='string'?result:JSON.stringify(result);},
          async text => {
            if(tool.name!=='code_workspace'||input?.action!=='propose')return;
            await restoreToolFileReceipt(this.coding,text,context);
          }) : actual(input);
        const result = await (activity ? withPublicActivity(activity, invoke) : invoke());
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        if (['code_workspace', 'web_search', 'get_hot_topics', 'get_recent_posts', 'search_forum_posts', 'get_forum_post', 'get_forum_categories', 'manage_forum_tracking'].includes(tool.name)) return text;
        const limit = positiveSetting('AGENT_TOOL_OUTPUT_CHAR_LIMIT', 3000, 12000);
        return text.length > limit ? text.slice(0, limit) + '\n[工具结果已截短；未提供的部分不能当作已读取]' : text;
      },
    }));

    // Plain chat/persona mode must not enable all tools or send an empty tools array.
    if (!tools.length) {
      const { chatHistory, lastUserInput } = this.convertMessages(messages);
      const input = [
        ...(systemPrompt ? [new SystemMessage(systemPrompt)] : []),
        ...chatHistory, new HumanMessage(lastUserInput),
      ];
      if (delivery) {
        let content = '';
        const stream = await llm.stream(input, { signal: delivery.signal });
        for await (const chunk of stream) {
          // Never forward reasoning_content, tool arguments or internal events.
          const text = typeof chunk.content === 'string' ? chunk.content : chunk.content
            .filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
          if (text) { content += text; await delivery.onToken(text); }
        }
        return { content, toolOutputs: [] };
      }
      const reply = await llm.invoke(input, { signal: runtimeState()?.signal });
      const content = typeof reply.content === 'string' ? reply.content : reply.content
        .filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
      return { content, toolOutputs: [] };
    }

    // 3. Build the agent prompt
    const promptMessages: any[] = [];

    if (systemPrompt) {
      promptMessages.push(new SystemMessage(systemPrompt));
    }
    if (this.toolRuns && context.runId) {
      const receipts=await this.toolRuns.receipts(context);
      if(receipts)promptMessages.push(new HumanMessage(receipts));
    }
    if (tools.some(t => t.name === 'code_workspace')) promptMessages.push(new SystemMessage(CODING_RULE));
    if (tools.some(t => t.name === 'web_search')) promptMessages.push(new SystemMessage(WEB_SEARCH_RULE));
    if (tools.some(t => ['get_hot_topics', 'get_recent_posts', 'search_forum_posts', 'get_forum_post', 'get_forum_categories', 'manage_forum_tracking'].includes(t.name)))
      promptMessages.push(new SystemMessage(FORUM_TOOL_RULE));

    promptMessages.push(new MessagesPlaceholder('chat_history'));
    promptMessages.push(HumanMessagePromptTemplate.fromTemplate('{input}'));
    promptMessages.push(new MessagesPlaceholder('agent_scratchpad'));

    const prompt = ChatPromptTemplate.fromMessages(promptMessages);

    // 4. Create the agent (as any to avoid TS2589 deep type instantiation)
    // Pass the declared JSON schema, rather than the OpenAI SDK's strict-Zod conversion:
    // that conversion changes every optional field to required even for non-strict providers.
    // LangChain's executable tools still validate the arguments locally.
    const boundModel = llm.bindTools(tools.map(tool => SkillRegistry.getTool(tool.name)?.getOpenAIFunction() ?? convertToOpenAITool(tool)));
    const agent = await createOpenAIToolsAgent({
      llm: { bindTools: () => boundModel } as any,
      tools: tools as any,
      prompt: prompt as any,
    });

    // 5. Create the executor
    const executor = new AgentExecutor({
      agent: agent as any,
      tools: tools as any,
      maxIterations: positiveSetting('AGENT_TOOL_MAX_ITERATIONS', 6, 6),
      handleParsingErrors: 'Error: 工具参数不符合声明的类型或范围，请修正参数后重试。不要把参数错误当作没有查询结果。',
      // This LangChain release otherwise swallows runtime exceptions into an
      // empty successful observation. Consent suspension and uncertain writes
      // must reach the durable task boundary, never trigger another model call.
      handleToolRuntimeErrors: (error:unknown) => { throw error; },
      returnIntermediateSteps: true,
    } as any);
    // LangChain's default force-stop returns an English placeholder as ordinary
    // output. A loop without a final model answer must take the durable task's
    // failure path, never become a successful saved assistant message. Override
    // only this execution's normalized agent; do not match answer strings or
    // mutate library globals, retry tools, or add a task-wide time/token quota.
    executor.agent.returnStoppedResponse = async () => { throw new AgentToolLoopIncompleteError(); };

    // 6. Convert messages to LangChain format
    const { chatHistory, lastUserInput } = this.convertMessages(messages);

    // 7. Execute
    this.logger.debug(`Executing agent with ${tools.length} tools, ${chatHistory.length} history messages`);

    const result = await executor.invoke({
      input: lastUserInput,
      chat_history: chatHistory,
    }, { signal: runtimeState()?.signal || delivery?.signal });

    // 8. Extract results
    let content = result.output || '';
    if (context.forumPostIds.size && await this.prismaService.post.count({ where: {
      id: { in: [...context.forumPostIds] }, status: 'APPROVED' } }) !== context.forumPostIds.size)
      throw new ServiceUnavailableException('引用的论坛帖子已变化或下架，请重新查询');
    if (context.forumPostIds.size) {
      const posts = await this.prismaService.post.findMany({ where: { id: { in: [...context.forumPostIds] }, status: 'APPROVED' }, select: { id: true, title: true } });
      if (posts.length !== context.forumPostIds.size) throw new ServiceUnavailableException('帖子已下架，请重新查询');
      content = attachForumLinks(content, [...context.forumPostIds].map(id => posts.find(p => p.id === id)!));
    }
    const toolOutputs = extractToolOutputs(result.intermediateSteps || []);
    return { content, toolOutputs };
    } finally { provider.clear(); }
  }

  /**
   * Convert AgentMessage[] to LangChain message format.
   * Returns the chat history (all messages except the last user message)
   * and the last user input string.
   */
  private convertMessages(messages: AgentMessage[]): {
    chatHistory: BaseMessage[];
    lastUserInput: string;
  } {
    const langChainMessages: BaseMessage[] = [];
    let lastUserInput = '';

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          // System messages go into the chat history
          langChainMessages.push(new SystemMessage(msg.content));
          break;
        case 'user':
          langChainMessages.push(new HumanMessage(msg.images?.length ? { content: [
            { type: 'text', text: msg.content },
            ...msg.images.flatMap((image, index) => [
              { type: 'text', text: JSON.stringify({ image: index + 1, file: image.path }) },
              { type: 'image_url', image_url: { url: image.url } },
            ]),
          ] } : msg.content));
          lastUserInput = msg.content; // Track last user message
          break;
        case 'assistant': {
          const aiMsg = new AIMessage(msg.content);
          // Preserve tool_calls if present (for multi-turn tool use)
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            (aiMsg as any).tool_calls = msg.tool_calls;
          }
          langChainMessages.push(aiMsg);
          break;
        }
        case 'tool':
          langChainMessages.push(
            new ToolMessage({
              content: msg.content,
              tool_call_id: msg.tool_call_id || '',
              name: msg.name,
            }),
          );
          break;
      }
    }

    // The last user message goes as {input}; remove it from chatHistory to avoid duplication
    if (lastUserInput) {
      const lastIdx = langChainMessages.length - 1;
      // Remove the last HumanMessage from history (it will be the {input})
      for (let i = lastIdx; i >= 0; i--) {
        if (langChainMessages[i] instanceof HumanMessage) {
          langChainMessages.splice(i, 1);
          break;
        }
      }
    }
    return { chatHistory: langChainMessages, lastUserInput };
  }

}
