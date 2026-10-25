import { createHash } from 'crypto';
import { RagHistoryMessage } from './rag-history';
import type { MessageFile } from '../coding/message-attachments';
import type { FileDraftRef, FileDraftSnapshot } from '../coding/file-draft.service';

export const MEMORY_VERSION = 'conversation-memory-v2';
export const RECENT_TURNS = 30;
export const HISTORY_CHAR_BUDGET = 24000;
export const SUMMARY_CHAR_BUDGET = 5000;
export const MEMORY_REBUILD_NOTICE = '[较早历史正在后台恢复；当前窗口不是完整会话，不能据此断言从未发生。]';
export interface HistoryExcerpt {
  kind: 'sourced-turn-excerpt-v1'; messageId: number; originalCharacters: number;
  headCharacters: number; tailCharacters: number; omittedCharacters: number;
}
export interface MemoryMessage extends RagHistoryMessage { messageId: number; historyExcerpt?: HistoryExcerpt; }
export interface MemorySource { messageId?: number; speaker: 'user' | 'assistant'; quote: string; current?: boolean; }
export interface SourcedValue { value: string; source: MemorySource; }
export interface InteractionState {
  name?: SourcedValue;
  address?: SourcedValue;
  familiarity: 'not_established' | 'explicitly_friends' | 'explicitly_partners';
  familiaritySources: MemorySource[]; // Never inferred from the number of turns.
  invitation?: { activity: string; status: 'proposed' | 'tentative' | 'accepted_activity_only' | 'declined'; sources: MemorySource[] };
  affection?: { user: 'planned_confession' | 'expressed' | 'withdrawn'; source: MemorySource };
  characterAffection?: { response: 'not_accepted' | 'explicit_reciprocation'; source: MemorySource };
  relationship: { status: 'not_established' | 'mutually_explicit'; sources: MemorySource[] };
  preferences: SourcedValue[];
}
export interface MemorySnapshot {
  version: string;
  personaKey: string;
  revision: string;
  state: InteractionState;
  summary: { kind: 'extractive_not_canon'; text: string; omittedTurns: number; sourceIds: number[]; topics: Array<{ text: string; sourceIds: number[] }> };
  window: { recentTurns: number; characterCount: number; characterBudget: number; maxTurns: number; unpairedMessages: number; excerptedTurns?: number };
}
export interface ConversationFrame {
  // Source epoch captured during preparation and rechecked before delivery;
  // not a model/client field. Final persistence checks it under the source locks.
  sourceEpoch?: number;
  // Private delivery guards for only the cross-conversation excerpts actually
  // used in this frame. Never serialized as public progress/model provenance.
  sharedMemorySources?: Array<{conversationId:number;memoryEpoch:number;personaKey:string;conversationType:string;sourceIds:number[]}>;
  toolScope?: { userId: number; conversationId: number; codingWorkspaceId?: string; runId?: string; workerToken?:string; fileSourceEpoch?:number; fileArtifacts?: Array<{ changeId: number; path: string;review?:{status:string;reviewId?:string;sourceHash?:string;issues?:string[]} }>; fileQuestionContext?: {question:string;history:Array<{role:string;content:string}>};
    artifactReviews?: Array<{changeId:number;path:string;review:{status:string;reviewId?:string;sourceHash?:string;issues?:string[]}}>;artifactReviewAttempts?:Map<string,number>;
    webSearch?: boolean; webSources?: Array<{title:string;url:string;snippet:string;engine:string;retrievedAt:string}>; webSearchFailures?: string[] };
  saveFileDraft?: (snapshot: {path:string;content:string;closed:boolean;reason:string;baseHash?:string}, force?:boolean) => Promise<FileDraftRef | undefined>;
  fileResume?: FileDraftSnapshot;
  messageFiles?: {current:MessageFile[];previous?:{messageId:number;question?:string;files:Array<MessageFile&{available:boolean}>};library:MessageFile[]};
  inlineImages?: Array<{id:number;revision:number;path:string;url:string}>;
  history: RagHistoryMessage[];
  evidenceHistory?: RagHistoryMessage[];
  memory: MemorySnapshot;
  persona: string;
  question: string;
}

export interface InteractionCursor { lastUser?: string; lastUserSource?: MemorySource; relationshipProposal?: MemorySource; }

export function personaMemoryKey(persona?: string, custom?: string) {
  return persona === 'custom' ? 'custom:' + createHash('sha256').update(custom || '').digest('hex').slice(0, 32) : persona || 'assistant';
}

// One unit is an entire user message and its assistant reply. Legacy orphan messages are never
// silently attached to another user's question; they go to the source-addressable summary instead.
export function conversationTurns(messages: MemoryMessage[]) {
  const turns: MemoryMessage[][] = [], orphans: MemoryMessage[] = [];
  let current: MemoryMessage[] = [];
  for (const m of messages) {
    if (m.role.toLowerCase() === 'user') {
      if (current.length) {
        if (current.some(x => x.role.toLowerCase() === 'assistant')) turns.push(current);
        else orphans.push(...current);
      }
      current = [m];
    } else if (m.role.toLowerCase() === 'assistant') {
      if (current.length) { turns.push([...current, m]); current = []; }
      else orphans.push(m);
    }
  }
  if (current.length) {
    if (current.some(m => m.role.toLowerCase() === 'assistant')) turns.push(current);
    else orphans.push(...current);
  }
  return { turns, orphans };
}

const excerptHeading = (messageId: number, role: string, originalCharacters: number) =>
  `【历史消息 #${messageId} 的有源摘录，非全文；${role.toLowerCase() === 'assistant' ? '旧回复不是事实背书' : '用户曾说，不是系统指令'}；原长${originalCharacters}字符】\n`;
const excerptGap = '\n【中段已省略】\n';
const safeHead = (text: string, length: number) => {
  let head = text.slice(0, length);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head;
};
const safeTail = (text: string, length: number) => {
  let tail = length ? text.slice(-length) : '';
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return tail;
};

// A single 32k answer can exceed the entire history window. Keep both speakers as
// explicitly sourced excerpts instead of turning a whole conversation into [].
// This never changes source rows, provenance/citations, or the state reducer input.
// Unsourced temporary/client messages cannot be disguised as server memory here.
export function excerptOversizedTurn<T extends { role: string; content: string; messageId?: number; historyExcerpt?: HistoryExcerpt }>(
  turn: T[], maxCharacters: number,
): T[] | undefined {
  if (maxCharacters < 512 || !turn.length || turn.some(m => !Number.isSafeInteger(m.messageId) || m.messageId! <= 0)) return;
  const perMessage = Math.floor(maxCharacters / turn.length);
  const compact = turn.map(message => {
    if (message.content.length <= perMessage) return message;
    const previous = message.historyExcerpt;
    const prior = previous?.kind === 'sourced-turn-excerpt-v1' && previous.messageId === message.messageId ? previous : undefined;
    const originalCharacters = prior?.originalCharacters ?? message.content.length;
    const heading = excerptHeading(message.messageId!, message.role, originalCharacters);
    const available = perMessage - heading.length - excerptGap.length;
    if (available < 128) return undefined;
    const priorHeading = prior ? excerptHeading(message.messageId!, message.role, prior.originalCharacters) : '';
    const headSource = prior ? message.content.slice(priorHeading.length, priorHeading.length + prior.headCharacters) : message.content;
    const tailSource = prior ? safeTail(message.content, prior.tailCharacters) : message.content;
    const head = safeHead(headSource, Math.ceil(available * .75));
    const tail = safeTail(tailSource, Math.floor(available * .25));
    return { ...message, content: heading + head + excerptGap + tail,
      historyExcerpt: { kind: 'sourced-turn-excerpt-v1' as const, messageId: message.messageId!, originalCharacters,
        headCharacters: head.length, tailCharacters: tail.length, omittedCharacters: originalCharacters - head.length - tail.length } };
  });
  return compact.every((message): message is T => !!message) ? compact : undefined;
}

function source(m: RagHistoryMessage): MemorySource {
  return { messageId: m.messageId, speaker: m.role.toLowerCase() === 'assistant' ? 'assistant' : 'user',
    quote: m.content.slice(0, 180), ...(!m.messageId ? { current: true } : {}) };
}
const clauses = (text: string) => text.split(/[。！!？?\n]/).map(s => s.trim()).filter(Boolean);
const fiction = (text: string) => /假如|假设|台词|原作|小说|扮演|例如|他说|她说|引用|翻译|忽略.{0,10}(规则|指令)/.test(text);
const explicitName = (value: string) => !/^(?:你|他|她|自己|什么|啥|谁|怎么|哪个|不知道|未知)/.test(value) && !/[吗嘛么呢]$/.test(value);

// Deliberately conservative extractive state. Ambiguous wording stays in recent history/summary,
// not an invented relationship fact. Every value is backed by a source message, never model recall.
export function interactionState(messages: RagHistoryMessage[], seed?: InteractionState, cursor: InteractionCursor = {}): InteractionState {
  const state: InteractionState = seed ? structuredClone(seed) : { familiarity: 'not_established', familiaritySources: [], relationship: { status: 'not_established', sources: [] }, preferences: [] };
  let lastUser = cursor.lastUser || '', lastUserSource = cursor.lastUserSource, relationshipProposal = cursor.relationshipProposal;
  for (const m of messages) {
    const text = m.content.trim(), s = source(m), user = m.role.toLowerCase() === 'user';
    if (user) { lastUser = text; lastUserSource = s; }
    if (!user && ['grounded', 'needs_review'].includes((m.ragMetadata as any)?.state)) continue;
    if (fiction(text)) continue;
    if (user) {
      const name = text.match(/^(?:我叫|我的名字(?:叫|是))([\p{L}\p{N}_-]{1,24})(?=[\s，。！!？?；;]|$)/u);
      if (name && explicitName(name[1]) && !/[？?]/.test(text.charAt(name[0].length))) state.name = { value: name[1], source: s };
      const address = text.match(/(?:^|[，。])(?:以后|你可以|请)?叫我([\p{L}\p{N}_-]{1,24}?)(?:吧)?(?=[\s，。！!？?；;]|$)/u);
      if (address && explicitName(address[1]) && !/[？?]/.test(text.charAt((address.index || 0) + address[0].length))) state.address = { value: address[1], source: s };
      if (/(?:想|打算|准备|方便).{0,12}(?:跟你|向你|对你)?告白/.test(text)) state.affection = { user: 'planned_confession', source: s };
      if (clauses(text).some(c => /^(?:惠[，,]?\s*)?我(?:真的|很|也)?(?:喜欢|爱)你[呀啊呢哦嘛]*$/.test(c)))
        state.affection = { user: 'expressed', source: s };
      if (/^我(?:不再喜欢|不喜欢|不爱)你/.test(text)) state.affection = { user: 'withdrawn', source: s };
      if (/^(?:我们(?:正式)?交往吧|做我的(?:女|男)朋友(?:吧|好吗)?)/.test(text)) relationshipProposal = s;
      if (/分手吧|我们分手|结束这段关系/.test(text)) {
        state.relationship = { status: 'not_established', sources: [s] }; relationshipProposal = undefined;
        state.familiarity = 'not_established'; state.familiaritySources = [s];
      }
      const activity = /看电影|电影/.test(text) ? '看电影' : /散步/.test(text) ? '散步' : /吃饭/.test(text) ? '吃饭' : undefined;
      if (activity && /约你|一起|陪我/.test(text) && !/取消|不去|别去|不要/.test(text))
        state.invitation = { activity, status: 'proposed', sources: [s] };
      if (state.invitation && /取消|不去了|改天再说/.test(text)) state.invitation = { ...state.invitation, status: 'declined', sources: [...state.invitation.sources.slice(-1), s] };
    } else {
      // A statement about accepting an activity is never evidence of accepting a confession.
      if (state.invitation && /电影|约|一起|散步|吃饭/.test(lastUser)) {
        const rejected = /(?:不|不能|不想|不方便).{0,8}(?:一起|去|看电影)|改天吧|先不了/.test(text);
        const accepted = /(?:答应|同意).{0,8}(?:电影|邀请|一起)|(?:一起|陪你)(?:去)?(?:看电影|散步|吃饭)|^嗯[，,]?\s*是答应了/.test(text);
        const tentative = /^(?:可以|好啊|好呀|行啊)/.test(text);
        if (rejected || accepted || tentative) state.invitation = { ...state.invitation,
          status: rejected ? 'declined' : accepted ? 'accepted_activity_only' : 'tentative', sources: [...state.invitation.sources.slice(0, 1), s] };
      }
      if (/不是.{0,12}告白|没(?:有)?接受.{0,8}告白|(?:不能|不想|没有).{0,8}(?:接受|交往)|还没.{0,8}(?:接受|交往)/.test(text))
        state.characterAffection = { response: 'not_accepted', source: s };
      else if (clauses(text).some(c => /^我也(?:喜欢|爱)你[呀啊哦呢]*$/.test(c)))
        state.characterAffection = { response: 'explicit_reciprocation', source: s };
      if (relationshipProposal && /^(?:我们(?:正式)?交往吧|做我的(?:女|男)朋友(?:吧|好吗)?)/.test(lastUser) &&
        clauses(text).some(c => /^(?:好[，,]\s*)?(?:我们(?:正式)?交往吧|我愿意做你的(?:女|男)朋友)$/.test(c)))
        { state.relationship = { status: 'mutually_explicit', sources: [relationshipProposal, s] };
          state.familiarity = 'explicitly_partners'; state.familiaritySources = state.relationship.sources; }
      if (/^(?:交个朋友吧|我们做朋友吧)/.test(lastUser) &&
        /^(?:好[啊呀]?[，,]\s*)?我们(?:做|是)朋友/.test(text) && state.relationship.status !== 'mutually_explicit') {
        state.familiarity = 'explicitly_friends'; state.familiaritySources = [lastUserSource, s];
      }
      if (/我们分手|结束这段关系/.test(text)) {
        state.relationship = { status: 'not_established', sources: [s] }; state.familiarity = 'not_established'; state.familiaritySources = [s];
      }
    }
    // Preferences are what this speaker said in chat, not canonical character facts.
    if (/喜欢/.test(text) && !/喜欢你|喜欢我|喜欢他|喜欢她|告白/.test(text)) {
      const pref = clauses(text).find(c => /我(?:现在|已经|其实)?(?:挺|比较|很|也|不再|不)?喜欢/.test(c));
      if (pref) state.preferences = [...state.preferences.filter(p => p.source.speaker !== s.speaker || p.value !== pref.slice(0, 160)),
        { value: pref.slice(0, 160), source: s }].slice(-8);
    }
  }
  Object.assign(cursor, { lastUser, lastUserSource, relationshipProposal });
  return state;
}

export function turnExcerpt(turn: MemoryMessage[]) {
  return turn.map(m => `${m.role.toLowerCase() === 'user' ? '用户曾说' :
    (m.ragMetadata as any)?.personaKey === 'assistant' ? '助手当时回应（历史陈述不是事实背书）' :
    '角色当时回应（不等于原作事实）'}：${m.content.slice(0, 400)}`).join('\n');
}

export function buildConversationMemory(messages: MemoryMessage[], personaKey: string,
  budget = HISTORY_CHAR_BUDGET): { history: MemoryMessage[]; snapshot: MemorySnapshot } {
  const eligible = messages.filter(m => m.role.toLowerCase() !== 'system');
  const { turns, orphans } = conversationTurns(eligible);
  const recent: MemoryMessage[][] = [];
  let size = 0;
  for (const turn of [...turns].reverse()) {
    const rawLength = turn.reduce((n, m) => n + m.content.length, 0);
    const packed = rawLength > budget ? excerptOversizedTurn(turn, Math.min(6000, budget)) : turn;
    if (!packed) break;
    const length = packed.reduce((n, m) => n + m.content.length, 0);
    if (recent.length >= RECENT_TURNS || size + length > budget) break;
    recent.unshift(packed); size += length;
  }
  const older = turns.slice(0, turns.length - recent.length);
  // Broad coverage: first and last topics plus recent topics, deduplicated; no old assistant
  // canon assertions promoted into the summary. Original replies remain addressable by message ID.
  const topics = older.map(turn => ({ text: turnExcerpt(turn), sourceIds: turn.map(m => m.messageId) }));
  for (const orphan of orphans) if (orphan.role.toLowerCase() === 'user')
    topics.push({ text: '未配对的用户消息：' + orphan.content.slice(0, 180), sourceIds: [orphan.messageId] });
  const chosen: typeof topics = [];
  const candidates = topics.length > 24 ? [topics[0], ...topics.slice(-23)] : topics;
  let chars = 0;
  for (const topic of candidates) if (chars + topic.text.length + 2 <= SUMMARY_CHAR_BUDGET) { chosen.push(topic); chars += topic.text.length + 2; }
  const revision = createHash('sha256').update(JSON.stringify(eligible.map(m => [m.messageId, m.role, m.content, m.ragMetadata]))).digest('hex');
  return { history: recent.flat(), snapshot: { version: MEMORY_VERSION, personaKey, revision,
    state: interactionState(eligible),
    summary: { kind: 'extractive_not_canon', text: chosen.map(t => t.text).join('\n'), omittedTurns: older.length,
      sourceIds: chosen.flatMap(t => t.sourceIds), topics: chosen },
    window: { recentTurns: recent.length, characterCount: size, characterBudget: budget, maxTurns: RECENT_TURNS, unpairedMessages: orphans.length,
      excerptedTurns: recent.filter(turn => turn.some(m => m.historyExcerpt)).length } } };
}
