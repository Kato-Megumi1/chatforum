import { RagCitation } from './rag.types';
import { SceneEventCard } from './scene-event-memory';

export interface RagHistoryMessage {
  role: string;
  content: string;
  messageId?: number;
  ragMetadata?: unknown;
}

// Only call this mapper with records loaded from the authenticated conversation.
// Client messages never acquire persisted provenance just by supplying a metadata field.
export function storedRagMessage(record: { id: number; role: string; content: string; ragMetadata?: unknown }): RagHistoryMessage {
  return { messageId: record.id, role: record.role.toLowerCase(), content: record.content.slice(0, 12000), ragMetadata: record.ragMetadata };
}

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const states = new Set(['grounded', 'needs_review', 'roleplay', 'general']);

export interface HistoryCitation {
  label?: number;
  chunkId: string;
  documentId: number;
  documentVersion: number;
  indexVersion: number;
  access: 'available' | 'unavailable' | 'different_knowledge_base' | 'version_mismatch' | 'lookup_failed';
  chapter?: string;
  page?: number;
  chunkIndex?: number;
  url?: string;
  fileName?: string;
  quote?: string;
  quoteStatus?: 'verbatim' | 'not_verbatim' | 'not_recorded';
}

export interface HistoryEvidence {
  kind: 'user_statement' | 'assistant_answer';
  recordedState: 'user_statement' | 'legacy_unverified' | 'grounded' | 'needs_review' | 'roleplay' | 'general';
  verification: 'historical_check_only' | 'unverified' | 'not_applicable';
  knowledgeBaseId?: number;
  indexVersion?: number;
  citations: HistoryCitation[];
  events?: SceneEventCard[];
}

export async function ragHistoryContext(
  history: RagHistoryMessage[], kbId: number,
  citation: (kbId: number, chunkId: string) => Promise<RagCitation & { content: string }>,
): Promise<Array<{ messageId?: number; role: string; content: string; evidence: HistoryEvidence }>> {
  const cache = new Map<string, Promise<RagCitation & { content: string }>>();
  // Windowing belongs to the shared conversation memory layer, not evidence enrichment.
  return Promise.all(history.map(async message => {
    const role = message.role.toLowerCase();
    const metadata = positive(message.messageId) ? object(message.ragMetadata) : {};
    const recordedState = role !== 'assistant' ? 'user_statement' : states.has(metadata.state) ? metadata.state : 'legacy_unverified';
    const evidence: HistoryEvidence = {
      kind: role === 'assistant' ? 'assistant_answer' : 'user_statement', recordedState,
      verification: recordedState === 'grounded' ? 'historical_check_only' : role !== 'assistant' ? 'not_applicable' : 'unverified',
      citations: [],
    };
    if (role === 'assistant') {
      if (positive(metadata.knowledgeBaseId)) evidence.knowledgeBaseId = metadata.knowledgeBaseId;
      if (positive(metadata.indexVersion)) evidence.indexVersion = metadata.indexVersion;
      for (const raw of (Array.isArray(metadata.citations) ? metadata.citations : []).slice(0, 8)) {
        const c = object(raw);
        if (typeof c.chunkId !== 'string' || !c.chunkId.length || c.chunkId.length > 100 ||
          ![c.documentId, c.documentVersion, c.indexVersion].every(positive)) continue;
        const source: HistoryCitation = { chunkId: c.chunkId, documentId: c.documentId,
          documentVersion: c.documentVersion, indexVersion: c.indexVersion, access: 'unavailable' };
        if (positive(c.label)) source.label = c.label;
        evidence.citations.push(source);
        if (evidence.knowledgeBaseId !== kbId) { source.access = 'different_knowledge_base'; continue; }
        try {
          if (!cache.has(c.chunkId)) cache.set(c.chunkId, citation(kbId, c.chunkId));
          const original = await cache.get(c.chunkId);
          if (original.documentId !== c.documentId || original.documentVersion !== c.documentVersion || original.indexVersion !== c.indexVersion) {
            source.access = 'version_mismatch'; continue;
          }
          source.access = 'available';
          source.chapter = original.chapter?.slice(0, 300);
          source.page = original.page;
          source.chunkIndex = original.chunkIndex;
          source.url = '/rag/knowledge-bases/' + kbId + '/citations/' + encodeURIComponent(c.chunkId);
          source.fileName = original.fileName?.slice(0, 300);
          source.quoteStatus = typeof c.quote !== 'string' || !c.quote ? 'not_recorded' :
            c.quote.length <= 160 && original.content.includes(c.quote) ? 'verbatim' : 'not_verbatim';
          if (source.quoteStatus === 'verbatim') source.quote = c.quote;
        } catch (error: any) {
          source.access = [401, 403, 404].includes(error?.getStatus?.()) ? 'unavailable' : 'lookup_failed';
        }
      }
      if (recordedState === 'grounded' && !evidence.citations.length) evidence.verification = 'unverified';
      if (recordedState === 'grounded' && Array.isArray(metadata.sceneEvents)) {
        evidence.events = metadata.sceneEvents.slice(0, 3).filter((e: any) => {
          const c = e?.citation;
          return e?.version === 'scene-event-memory-v1' && typeof e.id === 'string' && e.id.length <= 64 &&
            typeof e.fact === 'string' && e.fact.length <= 1200 && typeof e.actor === 'string' && e.actor.length <= 80 &&
            typeof e.action === 'string' && e.action.length <= 80 &&
            [e.recipient,e.object].every(v=>v==null || typeof v==='string' && v.length<=120) &&
            evidence.citations.some(s => s.access === 'available' && s.quoteStatus === 'verbatim' &&
              s.chunkId === c?.chunkId && s.documentId === c.documentId && s.documentVersion === c.documentVersion &&
              s.indexVersion === c.indexVersion && s.quote === e.quote);
        }).map((e: SceneEventCard) => {
          const c = evidence.citations.find(s => s.chunkId === e.citation.chunkId && s.access === 'available' && s.quoteStatus === 'verbatim')!;
          return { version: e.version, id: e.id, fact: e.fact, actor: e.actor,
          recipient: e.recipient, action: e.action, object: e.object, quote: e.quote,
          citation: { chunkId: c.chunkId, documentId: c.documentId, documentVersion: c.documentVersion,
            indexVersion: c.indexVersion, chunkIndex: c.chunkIndex!, fileName: c.fileName!, url: c.url!, chapter: c.chapter, page: c.page },
          verification: 'historical_check_only' as const, storyTime: null };
        });
      }
    }
    return { messageId: positive(message.messageId) ? message.messageId : undefined,
      role, content: message.content, evidence };
  }));
}

// Persist a bounded manifest, never recursively copy the history's full metadata or text.
export function historyEvidenceManifest(context: Awaited<ReturnType<typeof ragHistoryContext>>) {
  return context.map(({ messageId, evidence: { events: _events, ...evidence } }) => ({ messageId, ...evidence,
    citations: evidence.citations.map(({ quote: _quote, ...source }) => source) }));
}

// A bounded source pool, never previous assistant prose promoted to current truth.
export function reusableHistorySources(context: Awaited<ReturnType<typeof ragHistoryContext>>) {
  const unique = new Map<string, HistoryCitation>();
  for (const m of [...context].reverse()) {
    if (m.evidence.recordedState !== 'grounded') continue;
    for (const c of m.evidence.citations) {
      if (c.access === 'available' && c.quoteStatus === 'verbatim' && !unique.has(c.chunkId)) unique.set(c.chunkId, c);
      if (unique.size === 6) return [...unique.values()];
    }
  }
  return [...unique.values()];
}
