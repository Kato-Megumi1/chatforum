import { ChatService } from './chat.service';

describe('ChatService public message projection', () => {
  const publicMessageSelect = expect.objectContaining({
    id: true, role: true, content: true, ragMetadata: true, tokens: true,
    conversationId: true, createdAt: true,
  });

  test('conversation list, detail and message endpoints never select historical provider reasoning', async () => {
    const prisma: any = {
      conversation: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn()
          .mockResolvedValueOnce({ id: 7, userId: 3, conversationType: 'ASSISTANT', messages: [] })
          .mockResolvedValueOnce({ id: 7, userId: 3 }),
      },
      chatMessage: { findMany: jest.fn().mockResolvedValue([]) },
      post: { findMany: jest.fn() },
    };
    const service = new ChatService(prisma, {} as any);

    await service.getConversations(3);
    const listSelect = prisma.conversation.findMany.mock.calls[0][0].include.messages.select;
    expect(listSelect).toEqual(publicMessageSelect);
    expect(listSelect).not.toHaveProperty('reasoningContent');

    await service.getConversation(7, 3);
    const detailSelect = prisma.conversation.findUnique.mock.calls[0][0].include.messages.select;
    expect(detailSelect).toEqual(publicMessageSelect);
    expect(detailSelect).not.toHaveProperty('reasoningContent');

    await service.getConversationMessages(7, 3);
    const messageSelect = prisma.chatMessage.findMany.mock.calls[0][0].select;
    expect(messageSelect).toEqual(publicMessageSelect);
    expect(messageSelect).not.toHaveProperty('reasoningContent');
  });
});
