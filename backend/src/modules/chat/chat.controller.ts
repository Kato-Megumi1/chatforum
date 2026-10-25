import { Controller, Get, Post, Put, Delete, Body, Param, Query, Header, UseGuards, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response as ExpressResponse } from 'express';


import { ChatService } from './chat.service';
import { ApiResponse } from '../../common/response.class';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { ChatRole } from '@prisma/client';
import configuration from '../../config/configuration';
import { SkillRegistry } from '../agent/skills';
import { AgentExecutorService } from '../agent/agent.executor';
import { NovelAnswerService } from '../agent/novel-answer.service';
import { storedRagMessage } from '../agent/rag-history';
import { BadRequestException, GoneException } from '@nestjs/common';
import { publicChatModels } from './chat-models';
import { ConversationIdentityDto, CreateConversationDto, UpdateConversationDto } from './conversation.dto';

@ApiTags('对话')
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly agentExecutor: AgentExecutorService,
    private readonly novel: NovelAnswerService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: '获取默认 LLM 配置' })
  getDefaultConfig() {
    return ApiResponse.ok(publicChatModels());
  }

  @Post('conversations')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建对话' })
  async createConversation(
    @CurrentUser() user: { sub: number },
    @Body() input: CreateConversationDto,
  ) {
    const result = await this.chatService.createConversation(user.sub, input.title, input);
    return ApiResponse.created(result);
  }

  @Put('conversations/:id/identity') @UseGuards(JwtAuthGuard)
  async configureIdentity(@Param('id') id: string, @CurrentUser() user: {sub:number}, @Body() input: ConversationIdentityDto) {
    return ApiResponse.ok(await this.chatService.configureIdentity(Number(id), user.sub, input));
  }

  @Get('conversations')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取对话列表' })
  async getConversations(@CurrentUser() user: { sub: number }) {
    const result = await this.chatService.getConversations(user.sub);
    return ApiResponse.ok(result);
  }

  @Get('conversations/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取对话详情' })
  async getConversation(
    @Param('id') id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.chatService.getConversation(parseInt(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Put('conversations/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新对话信息' })
  async updateConversation(
    @Param('id') id: string,
    @CurrentUser() user: { sub: number },
    @Body() data: UpdateConversationDto,
  ) {
    const result = await this.chatService.updateConversation(parseInt(id), user.sub, data);
    return ApiResponse.ok(result);
  }

  @Delete('conversations/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除对话' })
  async deleteConversation(
    @Param('id') id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.chatService.deleteConversation(parseInt(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Get('conversations/:id/messages')
  @Header('Cache-Control','private, no-store')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取对话消息' })
  async getMessages(
    @Param('id') id: string,
    @CurrentUser() user: { sub: number },
    @Query('pagination') pagination?:unknown,
    @Query('limit') limit?:unknown,
    @Query('before') before?:unknown,
    @Query('around') around?:unknown,
  ) {
    if(pagination!==undefined&&pagination!=='seek')throw new BadRequestException('消息分页方式无效');
    if(pagination==='seek'){
      if(!/^[1-9]\d{0,9}$/.test(id))throw new BadRequestException('对话编号无效');
      return ApiResponse.ok(await this.chatService.getMessagePage(Number(id),user.sub,{limit,before,around}));
    }
    const result = await this.chatService.getConversationMessages(parseInt(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Post('stream')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '流式对话' })
  async streamChat(
    @CurrentUser() user: { sub: number },
    @Body('messages') messages: Array<{ role: string; content: string }>,
    @Body('apiKey') apiKey?: string,
    @Body('apiBase') apiBase?: string,
    @Body('model') model?: string,
    @Body('temperature') temperature?: number,
    @Body('maxTokens') maxTokens?: number,
    @Body('conversationId') conversationId?: number,
    @Res() res?: ExpressResponse,
  ) {
    if (process.env.ENABLE_LEGACY_SSE !== 'true') throw new GoneException('请使用 /chat/runs 持久化对话接口');
    ({ apiKey, apiBase, model } = this.serverModel());
    messages = this.validateMessages(messages);
    if (conversationId) await this.chatService.getConversationMessages(conversationId, user.sub);
    if (!apiKey || !apiBase || !model) {
      res.status(400).json({ success: false, message: 'Missing LLM configuration' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let streamResponse: any;
    try {
      streamResponse = await this.chatService.streamChat(
        messages,
        apiKey,
        apiBase,
        model,
        temperature,
        maxTokens,
      );
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ error: err.message || 'API request failed' })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }

    if (conversationId) {
      // Save only new messages (beyond what's already in DB) using index-based check
      const existingMessages = await this.chatService.getConversationMessages(conversationId, user.sub);
      const existingCount = existingMessages.length;

      for (let i = existingCount; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.content) continue;

        const roleLower = (msg.role || '').toLowerCase();
        const role = roleLower === 'assistant' ? ChatRole.ASSISTANT : ChatRole.USER;
        await this.chatService.addMessage(
          conversationId,
          user.sub,
          role,
          msg.content,
        );
      }
    }

    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let fullReasoning = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            const content = delta?.content || '';
            const reasoning = delta?.reasoning_content || '';
            if (content) {
              fullContent += content;
              res.write(`data: ${JSON.stringify({ content })}\n\n`);
            }
            if (reasoning) {
              fullReasoning += reasoning;
              res.write(`data: ${JSON.stringify({ reasoning_content: reasoning })}\n\n`);
            }
          } catch {
            // Ignore malformed JSON (partial chunk, etc.)
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`Stream read error: ${err.message}`);
    }

    // Release lock safely (may throw if already released)
    try { reader.releaseLock(); } catch {}

    // Save assistant response to DB
    if (conversationId && (fullContent || fullReasoning)) {
      try {
        await this.chatService.addMessage(
          conversationId,
          user.sub,
          ChatRole.ASSISTANT,
          fullContent,
          undefined,
          fullReasoning || undefined,
        );
      } catch (err: any) {
        this.logger.error(`Failed to save assistant message: ${err.message}`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  }

  @Get('templates')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取 Prompt 模板' })
  async getPromptTemplates(@CurrentUser() user: { sub: number }) {
    const result = await this.chatService.getPromptTemplates(user.sub);
    return ApiResponse.ok(result);
  }

  @Post('templates')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建 Prompt 模板' })
  async createPromptTemplate(
    @CurrentUser() user: { sub: number },
    @Body() data: any,
  ) {
    const result = await this.chatService.createPromptTemplate(user.sub, data);
    return ApiResponse.created(result);
  }

  @Delete('conversations/:id/messages/:messageId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除对话中的某条消息' })
  async deleteMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.chatService.deleteMessage(parseInt(id), parseInt(messageId), user.sub);
    return ApiResponse.ok(result);
  }

  @Get('skills')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取可用技能列表' })
  async getSkills() {
    return ApiResponse.ok(SkillRegistry.getAllMeta());
  }

  @Post('agent-stream')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Agent 流式对话（支持工具调用）' })
  async agentStreamChat(
    @CurrentUser() user: { sub: number },
    @Body('messages') messages: Array<{ role: string; content: string }>,
    @Body('apiKey') apiKey?: string,
    @Body('apiBase') apiBase?: string,
    @Body('model') model?: string,
    @Body('temperature') temperature?: number,
    @Body('maxTokens') maxTokens?: number,
    @Body('conversationId') conversationId?: number,
    @Body('enabledSkills') enabledSkills?: string[],
    @Body('persona') persona?: string,
    @Body('customSystemPrompt') customSystemPrompt?: string,
    @Body('knowledgeBaseId') knowledgeBaseId?: number,
    @Res() res?: ExpressResponse,
  ) {
    if (process.env.ENABLE_LEGACY_SSE !== 'true') throw new GoneException('请使用 /chat/runs 持久化对话接口');
    if (persona || knowledgeBaseId) throw new GoneException('角色与知识库对话请使用 /chat/runs，以保留统一记忆和关系状态');
    ({ apiKey, apiBase, model } = this.serverModel());
    messages = this.validateMessages(messages);
    if (conversationId) await this.chatService.getConversationMessages(conversationId, user.sub);
    if (!apiKey || !apiBase || !model) {
      res.status(400).json({ success: false, message: 'Missing LLM configuration' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // 将简单消息格式转换为 Agent 消息格式
      const agentMessages = messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content,
      }));

      // 提取最后一条用户消息（用于 RAG 检索）
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');

      // 提取角色扮演技能的系统提示词（或使用 Agent 默认身份）
      let systemPrompt: string | undefined;
      if (persona === 'custom' && customSystemPrompt) {
        systemPrompt = customSystemPrompt;
      } else if (persona) {
        const personaSkill = SkillRegistry.getPersonaSkill(persona);
        if (personaSkill && typeof (personaSkill as any).getSystemPrompt === 'function') {
          systemPrompt = (personaSkill as any).getSystemPrompt();
        }
      } else {
        systemPrompt = `你是 ChatForum 的智能助手，由 py 设计和开发。你是一个友好、乐于助人的 AI 助手，能够访问论坛数据、搜索互联网、执行计算等工具来帮助用户。

你的能力包括：
- 查询论坛热帖、最新帖子和搜索论坛内容
- 搜索互联网获取最新信息
- 执行数学计算和代码
- 查询天气和日期时间

请用中文回复，保持简洁有帮助。`;
      }

      // Novel evidence stays in a tool-free, structured generation path.
      if (persona && knowledgeBaseId && lastUserMsg) {
        const storedHistory = conversationId ? await this.chatService.getConversationMessages(conversationId, user.sub) : [];
        const ragHistory = [...storedHistory.filter(m => m.role !== ChatRole.SYSTEM).map(storedRagMessage),
          { role: 'user', content: lastUserMsg.content }];
        const result = await this.novel.answer(knowledgeBaseId, lastUserMsg.content,
          ragHistory, systemPrompt || '', { userId: user.sub });
        if (conversationId) {
          await this.chatService.addMessage(conversationId, user.sub, ChatRole.USER, lastUserMsg.content);
          await this.chatService.addMessage(conversationId, user.sub, ChatRole.ASSISTANT,
            result.content, undefined, undefined, JSON.parse(JSON.stringify(result.metadata)));
        }
        res.write('data: ' + JSON.stringify({ type: 'final_content', content: result.content, ragMetadata: result.metadata }) + '\n\n');
        res.write('data: ' + JSON.stringify({ type: 'done' }) + '\n\n');
        res.end();
        return;
      }
      const { content, toolOutputs, reasoningContent } = await this.agentExecutor.executeWithTools(
        agentMessages,
        apiKey,
        apiBase,
        model,
        temperature,
        maxTokens,
        enabledSkills,
        systemPrompt,
      );

      // Format content with tool result markers for frontend display only
      let displayContent = content;
      if (toolOutputs.length > 0) {
        const toolResultsSection = toolOutputs
          .map(t => `\n\n---SKILL_RESULT_START---\n\n${t.displayText}\n\n---SKILL_RESULT_END---\n`)
          .join('\n');
        displayContent = toolResultsSection + '\n\n' + content;
      }

      // 发送工具调用结果事件
      if (toolOutputs.length > 0) {
        for (const output of toolOutputs) {
          res.write(`data: ${JSON.stringify({ type: 'tool_result', ...output })}\n\n`);
        }
      }

      // 发送最终回复内容（包含工具结果标记，用于前端展示）
      res.write(`data: ${JSON.stringify({ type: 'final_content', content: displayContent || '' })}\n\n`);

      // 保存到数据库（只保存干净的回复内容，不包含工具结果标记）
      if (conversationId) {
        const existingMessages = await this.chatService.getConversationMessages(conversationId, user.sub);
        const existingCount = existingMessages.length;

        for (let i = existingCount; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg.content) continue;
          const roleLower = (msg.role || '').toLowerCase();
          const role = roleLower === 'assistant' ? ChatRole.ASSISTANT : ChatRole.USER;
          await this.chatService.addMessage(conversationId, user.sub, role, msg.content);
        }

        // 只保存干净的回复内容（不包含工具结果标记），保证多轮对话上下文干净
        if (content || reasoningContent) {
          await this.chatService.addMessage(conversationId, user.sub, ChatRole.ASSISTANT, content, undefined, reasoningContent);
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    } catch (err: any) {
      this.logger.error(`Agent stream error: ${err.message}`, err.stack);
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'Agent execution failed' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    }
  }

  private serverModel() {
    const config = configuration().llm;
    return { apiKey: config.defaultApiKey, apiBase: config.defaultApiBase, model: config.defaultModel };
  }

  private validateMessages(messages: Array<{ role: string; content: string }>) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 200 ||
      messages.some(m => !m || typeof m.content !== 'string' || m.content.length > 12000 ||
        !['user', 'assistant'].includes(String(m.role).toLowerCase()))) {
      throw new BadRequestException('消息格式无效或上下文过长');
    }
    return messages.map(m => ({ role: m.role.toLowerCase(), content: m.content }));
  }
}
