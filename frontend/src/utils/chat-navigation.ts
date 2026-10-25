export type ChatSpace = 'ASSISTANT' | 'ROLEPLAY' | 'LEGACY';
export interface ChatNavigation {
  userId: number; space: ChatSpace; conversationId: number | null; scroll: Record<number, number>;
}
export const CHAT_NAVIGATION_KEY = 'chatforum-chat-navigation-v1';
export const emptyChatNavigation = (userId: number): ChatNavigation => ({ userId, space: 'ASSISTANT', conversationId: null, scroll: {} });

export function readChatNavigation(raw: string | null, userId: number): ChatNavigation {
  const fallback = emptyChatNavigation(userId);
  try {
    const saved = JSON.parse(raw || 'null');
    if (saved?.userId !== userId || !['ASSISTANT', 'ROLEPLAY', 'LEGACY'].includes(saved.space)) return fallback;
    const scroll: Record<number, number> = {};
    for (const [id, value] of Object.entries(saved.scroll || {}).slice(-100))
      if (/^[1-9]\d*$/.test(id) && typeof value === 'number' && Number.isFinite(value) && value >= 0) scroll[Number(id)] = value;
    return { userId, space: saved.space, conversationId: Number.isSafeInteger(saved.conversationId) && saved.conversationId > 0 ? saved.conversationId : null, scroll };
  } catch { return fallback; }
}

export function initialChat<T extends { id: number; userId: number; conversationType?: string }>(conversations: T[], saved: ChatNavigation) {
  const owned = conversations.filter(c => c.userId === saved.userId);
  const previous = owned.find(c => c.id === saved.conversationId);
  if (previous) return { space: (previous.conversationType || 'LEGACY') as ChatSpace, conversation: previous };
  // A first visit (or a deleted/unavailable saved conversation) never implicitly opens legacy history.
  if (!saved.conversationId && saved.space === 'ROLEPLAY') return { space: 'ROLEPLAY' as ChatSpace, conversation: undefined };
  return { space: 'ASSISTANT' as ChatSpace, conversation: owned.find(c => c.conversationType === 'ASSISTANT') };
}
