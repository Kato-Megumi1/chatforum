import { Injectable, NotFoundException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import { conversationIdentity } from './conversation-type';
import { PrismaService } from '../../common/prisma.service';
import { ChatRole, Prisma } from '@prisma/client';
import { ConversationMemoryService } from '../agent/conversation-memory.service';
import { attachForumLinks, legacyForumTitles } from '../forum/forum-answer-links';
import { decodeMessageCursor, encodeMessageCursor } from './chat-history.cursor';

// Historical rows may contain provider reasoning written by the retired SSE
// endpoints. Keep those rows for compatibility/audit, but never serialize that
// private field through current conversation APIs.
const PUBLIC_CHAT_MESSAGE_SELECT = {
  id: true, role: true, content: true, ragMetadata: true, tokens: true,
  conversationId: true, createdAt: true,
} satisfies Prisma.ChatMessageSelect;

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService, private readonly memory: ConversationMemoryService) {}

  async createConversation(userId: number, title?: string, identity: Parameters<typeof conversationIdentity>[0] = {}) {
    return this.prisma.conversation.create({
      data: {
        userId,
        ...conversationIdentity(identity),
        title: title || 'New Conversation',
      },
    });
  }

  async getConversations(userId: number) {
    return this.prisma.conversation.findMany({
      where: { userId },
      orderBy: [
        { isPinned: 'desc' },
        { updatedAt: 'desc' },
      ],
      include: {
        _count: {
          select: { messages: true },
        },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: PUBLIC_CHAT_MESSAGE_SELECT,
        },
      },
    });
  }

  async getConversation(conversationId: number, userId: number) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: [{ createdAt: 'desc' },{id:'desc'}],
          take:40,
          select: PUBLIC_CHAT_MESSAGE_SELECT,
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    conversation.messages.reverse();

    // Read-time navigation repair only: never rewrites stored history or its evidence status.
    if (conversation.conversationType === 'ASSISTANT') {
      const titles = [...new Set(conversation.messages.filter(m => m.role === 'ASSISTANT').flatMap(m => legacyForumTitles(m.content)))].slice(0, 100);
      if (titles.length) {
        const matches = await this.prisma.post.findMany({ where: { title: { in: titles }, status: 'APPROVED' }, select: { id: true, title: true }, take: 1001 });
        const unique = matches.length < 1001 ? matches.filter(p => matches.filter(q => q.title === p.title).length === 1) : [];
        for (const message of conversation.messages) if (message.role === 'ASSISTANT') message.content = attachForumLinks(message.content, unique, false);
      }
    }
    return conversation;
  }

  async updateConversation(conversationId: number, userId: number, data: any) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if(typeof data.sharedMemory==='boolean'&&conversation.conversationType!=='LEGACY')
      return this.prisma.$transaction(async tx=>{
        const account=await tx.$queryRaw<Array<{id:number}>>`SELECT id FROM users WHERE id=${userId} AND status='ACTIVE' FOR UPDATE`;
        if(!account.length)throw new ForbiddenException('账号不可用');
        await tx.$queryRaw`SELECT id FROM conversations WHERE id=${conversationId} AND userId=${userId} FOR UPDATE`;
        const current=await tx.conversation.findFirst({where:{id:conversationId,userId}});
        if(!current)throw new ForbiddenException('对话不可访问');
        const changed=current.sharedMemory!==data.sharedMemory&&current.conversationType!=='LEGACY';
        const updated=await tx.conversation.update({where:{id:conversationId},data:{
          ...(typeof data.title==='string'?{title:data.title.slice(0,100)}:{}),
          ...(typeof data.isPinned==='boolean'?{isPinned:data.isPinned}:{}),
          ...(changed?{sharedMemory:data.sharedMemory,memoryEpoch:{increment:1}}:{}),
        }});
        if(changed&&updated.personaKey){
          await tx.conversationMemory.deleteMany({where:{conversationId}});
          await tx.conversationEpisode.deleteMany({where:{conversationId}});
          await tx.forumQueryCheckpoint.deleteMany({where:{conversationId}});
          await tx.memoryRebuildJob.upsert({where:{conversationId},create:{conversationId,userId,personaKey:updated.personaKey,epoch:updated.memoryEpoch},
            update:{epoch:updated.memoryEpoch,personaKey:updated.personaKey,status:'QUEUED',workerToken:null,leaseUntil:null,
              attempts:0,errorCode:null,nextAttemptAt:new Date()}});
        }
        return updated;
      });
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { ...(typeof data.title === 'string' ? { title: data.title.slice(0, 100) } : {}),
        ...(typeof data.isPinned === 'boolean' ? { isPinned: data.isPinned } : {}) },
    });
  }

  async configureIdentity(conversationId: number, userId: number, data: Parameters<typeof conversationIdentity>[0]) {
    const identity = conversationIdentity(data);
    return this.prisma.$transaction(async tx => {
      const owned = await tx.$queryRaw<Array<{id:number}>>`SELECT id FROM conversations WHERE id=${conversationId} AND userId=${userId} FOR UPDATE`;
      if (!owned.length) throw new ForbiddenException('Access denied');
      if (await tx.chatMessage.count({ where: { conversationId } }) ||
        await tx.chatRun.count({ where: { conversationId, status: { in: ['QUEUED','RUNNING','WAITING_APPROVAL'] } } }))
        throw new ConflictException('已有消息的会话不能换角色，请新建会话');
      await tx.conversationMemory.deleteMany({ where: { conversationId } });
      await tx.conversationEpisode.deleteMany({ where: { conversationId } });
      await tx.forumQueryCheckpoint.deleteMany({ where: { conversationId } });
      return tx.conversation.update({ where: { id: conversationId }, data: { ...identity, sharedMemory: false, memoryEpoch: { increment: 1 } } });
    });
  }

  async deleteConversation(conversationId: number, userId: number) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    await this.prisma.conversation.delete({
      where: { id: conversationId },
    });

    return { message: 'Conversation deleted' };
  }

  async addMessage(conversationId: number, userId: number, role: ChatRole, content: string, tokens?: number, reasoningContent?: string, ragMetadata?: Prisma.InputJsonValue) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return this.prisma.$transaction(async tx => {
      await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      return tx.chatMessage.create({
      data: {
        conversationId,
        role,
        content,
        tokens,
        reasoningContent,
        ragMetadata,
      },
      });
    });
  }

  async deleteMessage(conversationId: number, messageId: number, userId: number) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const message = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, conversationId },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    await this.prisma.$transaction(async tx => {
      await tx.conversation.update({ where: { id: conversationId }, data: { memoryEpoch: { increment: 1 } } });
      await tx.chatMessage.delete({ where: { id: messageId } });
      await tx.conversationMemory.deleteMany({ where: { conversationId } });
      await tx.conversationEpisode.deleteMany({ where: { conversationId } });
      await tx.forumQueryCheckpoint.deleteMany({ where: { conversationId } });
    });

    return { message: 'Message deleted' };
  }

  async getConversationMessages(conversationId: number, userId: number) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const rows=await this.prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' },{id:'desc'}],
      take:40,
      select: PUBLIC_CHAT_MESSAGE_SELECT,
    });
    return rows.reverse();
  }

  async getMessagePage(conversationId:number,userId:number,options:{limit?:unknown;before?:unknown;around?:unknown}={}) {
    if(!Number.isSafeInteger(conversationId)||conversationId<1||conversationId>2147483647||!Number.isSafeInteger(userId)||userId<1)
      throw new BadRequestException('对话编号无效');
    const integer=(value:unknown,fallback?:number)=>{
      if(value===undefined)return fallback;
      if(typeof value!=='string'||!/^\d{1,10}$/.test(value))throw new BadRequestException('消息分页参数无效');
      const result=Number(value);if(!Number.isSafeInteger(result)||result<1||result>2147483647)throw new BadRequestException('消息分页参数无效');return result;
    };
    const limit=integer(options.limit,40)!;if(limit>80)throw new BadRequestException('每页最多80条消息');
    const around=integer(options.around);
    if(around&&options.before!==undefined)throw new BadRequestException('不能同时指定来源定位和旧页游标');
    const conversation=await this.prisma.conversation.findFirst({where:{id:conversationId,userId,user:{status:'ACTIVE'}},select:{id:true}});
    if(!conversation)throw new ForbiddenException('对话不可访问');
    const boundary=options.before===undefined?undefined:decodeMessageCursor(options.before as string,userId,conversationId);
    let rows:any[],hasMore=false;
    if(around){
      const anchor=await this.prisma.chatMessage.findFirst({where:{id:around,conversationId},select:{id:true,createdAt:true}});
      if(!anchor)throw new NotFoundException('原消息已删除或不可访问');
      const older=await this.prisma.chatMessage.findMany({where:{conversationId,OR:[{createdAt:{lt:anchor.createdAt}},
        {createdAt:anchor.createdAt,id:{lte:anchor.id}}]},orderBy:[{createdAt:'desc'},{id:'desc'}],take:Math.ceil(limit/2)+1,select:PUBLIC_CHAT_MESSAGE_SELECT});
      hasMore=older.length>Math.ceil(limit/2);rows=older.slice(0,Math.ceil(limit/2)).reverse();
      const newer=await this.prisma.chatMessage.findMany({where:{conversationId,OR:[{createdAt:{gt:anchor.createdAt}},
        {createdAt:anchor.createdAt,id:{gt:anchor.id}}]},orderBy:[{createdAt:'asc'},{id:'asc'}],take:limit-rows.length,select:PUBLIC_CHAT_MESSAGE_SELECT});
      rows.push(...newer);
    }else{
      const fetched=await this.prisma.chatMessage.findMany({where:{conversationId,...(boundary?{OR:[{createdAt:{lt:boundary.createdAt}},
        {createdAt:boundary.createdAt,id:{lt:boundary.id}}]}:{})},orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit+1,select:PUBLIC_CHAT_MESSAGE_SELECT});
      hasMore=fetched.length>limit;rows=fetched.slice(0,limit).reverse();
    }
    return {items:rows,hasMore,olderCursor:hasMore&&rows.length?encodeMessageCursor(userId,conversationId,rows[0]):null,
      ...(around?{anchorId:around}:{})};
  }

  async streamChat(
    messages: Array<{ role: string; content: string }>,
    apiKey: string,
    apiBase: string,
    model: string,
    temperature?: number,
    maxTokens?: number,
  ) {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch (e) {
        // ignore
      }
      throw new Error(`API request failed: ${response.status} ${response.statusText}${errorBody ? ' - ' + errorBody : ''}`);
    }

    return response;
  }

  async getPromptTemplates(userId?: number) {
    return this.prisma.promptTemplate.findMany({
      where: {
        OR: [
          { isPublic: true },
          ...(userId ? [{ userId }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createPromptTemplate(userId: number, data: any) {
    return this.prisma.promptTemplate.create({
      data: {
        name: String(data.name || '').slice(0, 100),
        content: String(data.content || '').slice(0, 12000),
        description: typeof data.description === 'string' ? data.description.slice(0, 500) : undefined,
        isPublic: false,
        userId,
      },
    });
  }
}
