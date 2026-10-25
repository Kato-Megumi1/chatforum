export interface ConversationSettings {
  agentMode: string;
  selectedPersona: string;
  customPersonaName: string;
  customPersonaPrompt: string;
  knowledgeBaseId: number;
  modelId?: string;
  codingEnabled?: boolean;
  katoDefaultKnowledgePending?: boolean;
  deepThinking?: boolean;
  webSearch?: boolean;
}

/** Missing options in older saved conversations use the same explicit defaults. */
export function conversationResponseOptions(settings?: Pick<ConversationSettings, 'deepThinking' | 'webSearch'>, conversationType = 'ASSISTANT') {
  return {
    deepThinking: conversationType === 'ASSISTANT' && (typeof settings?.deepThinking === 'boolean' ? settings.deepThinking : true),
    webSearch: conversationType === 'ASSISTANT' && settings?.webSearch === true,
  };
}

interface ConversationIdentity {
  conversationType?: string;
  personaKey?: string;
}

/** Apply defaults once, after the server has identified the conversation. */
export function ensureConversationSettings(
  settings: Record<number, ConversationSettings>,
  id: number,
  identity?: ConversationIdentity | null,
): ConversationSettings {
  if (Object.prototype.hasOwnProperty.call(settings, id)) return settings[id];
  const kato = identity?.conversationType === 'ROLEPLAY' && identity.personaKey === 'kato_megumi_persona';
  const created: ConversationSettings = {
    agentMode: kato ? 'agent' : 'normal',
    selectedPersona: '',
    customPersonaName: '',
    customPersonaPrompt: '',
    knowledgeBaseId: 0,
    deepThinking: identity?.conversationType !== 'ROLEPLAY' && identity?.conversationType !== 'LEGACY',
    webSearch: false,
    ...(kato ? { katoDefaultKnowledgePending: true } : {}),
  };
  settings[id] = created;
  // Read through the reactive map so first-use computed getters track fields.
  return settings[id];
}

interface KnowledgeDocumentSummary {
  fileName?: string;
  isCurrent?: boolean;
  status?: string;
}

interface KnowledgeBaseSummary {
  id: number;
  name?: string;
  chatReady?: boolean;
  documents?: KnowledgeDocumentSummary[];
}

const normalizeName = (value: unknown): string => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[\s·•・_—–-]+/gu, '') : '';
const hasNovelTitle = (value: string): boolean => /路人女主|不起眼女主角/u.test(value);
const preferredName = normalizeName('路人女主 · 加藤惠的原作记忆');

/** The caller supplies only the current user's server-filtered readable list. */
export function defaultKatoKnowledgeBaseId(books: readonly KnowledgeBaseSummary[]): number | undefined {
  const ready = books.filter(book => book.chatReady === true && Number.isSafeInteger(book.id) && book.id > 0);
  const uniqueId = (matches: KnowledgeBaseSummary[]): number | undefined => {
    const ids = new Set(matches.map(book => book.id));
    return ids.size === 1 ? ids.values().next().value : undefined;
  };
  const exact = ready.filter(book => normalizeName(book.name) === preferredName);
  if (exact.length) return uniqueId(exact);

  return uniqueId(ready.filter(book => {
    const name = normalizeName(book.name);
    if (hasNovelTitle(name) && name.includes('加藤惠')) return true;
    // Only current, completed original-file metadata can identify a renamed library.
    // Historical revisions and descriptions do not establish a default source.
    return book.documents?.some(document => document.isCurrent === true && document.status === 'COMPLETED' &&
      hasNovelTitle(normalizeName(document.fileName))) === true;
  }));
}
