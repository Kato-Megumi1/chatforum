import type { ChatFile } from './chat-files';

export interface DraftSession { userId: number | null; epoch: number }
export interface ChatDraft { text: string; files: ChatFile[] }

// Route lifetime is deliberately not an identity boundary: a durable task can
// fail after the chat view unmounts. Logging out, including back into the same
// account, must still invalidate its old acceptance/recovery callbacks.
export function sameDraftSession(expected: DraftSession, current: DraftSession, navigationUserId: number): boolean {
  return expected.userId !== null && expected.userId === current.userId &&
    expected.epoch === current.epoch && expected.userId === navigationUserId;
}

export function sameDraftFiles(left: readonly ChatFile[], right: readonly ChatFile[]): boolean {
  const kind = (file: ChatFile) => !file.kind || file.kind === 'text' ? 'text' : 'attachment';
  return left.length === right.length && left.every((file, index) => file.id === right[index].id &&
    kind(file) === kind(right[index]) && file.revision === right[index].revision);
}

/** Return a recovery plan, never mutate a draft or replace a newer selection. */
export function recoverChatDraft(input: {
  expectedSession: DraftSession; currentSession: DraftSession; navigationUserId: number;
  conversationExists: boolean; current: ChatDraft; failed: ChatDraft;
}): ChatDraft | undefined {
  if (!sameDraftSession(input.expectedSession, input.currentSession, input.navigationUserId) ||
    !input.conversationExists || input.current.text.length ||
    input.current.files.length && !sameDraftFiles(input.current.files, input.failed.files)) return undefined;
  return { text: input.failed.text, files: input.failed.files.map(file => ({ ...file })) };
}
