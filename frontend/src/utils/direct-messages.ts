export interface DirectPeer {
  id: number;
  username: string;
  avatar?: string | null;
  status: string;
}
export interface DirectMessage {
  id: string;
  senderId: number;
  content: string;
  clientMessageId: string;
  createdAt: string;
}
export interface DirectConversation {
  id: number;
  peer: DirectPeer;
  state: "PENDING" | "ACCEPTED" | "DECLINED";
  requestDirection: "incoming" | "outgoing" | null;
  canSend: boolean;
  canAccept?: boolean;
  canDecline?: boolean;
  blockedByMe: boolean;
  blocked: boolean;
  unreadCount: number;
  lastMessage: Pick<
    DirectMessage,
    "id" | "content" | "senderId" | "createdAt"
  > | null;
}
export function messageIdAfter(value: string, previous: string) {
  return (
    /^\d+$/.test(value) &&
    /^\d+$/.test(previous) &&
    BigInt(value) > BigInt(previous)
  );
}
export function mergeDirectMessages(
  old: DirectMessage[],
  incoming: DirectMessage[],
) {
  const rows = new Map(old.map((message) => [message.id, message]));
  for (const message of incoming)
    if (/^\d+$/.test(message.id)) rows.set(message.id, message);
  return [...rows.values()].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  );
}
export function directMessageDraftKey(account: number, conversation: number) {
  return `${account}:${conversation}`;
}
export function uncertainDirectSend(error: any) {
  const status = error?.response?.status;
  return (
    error?.code !== "AUTH_SESSION_CHANGED" && !(status >= 400 && status < 500)
  );
}
