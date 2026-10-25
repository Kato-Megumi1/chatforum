import { createHash } from 'crypto';
import { RagCitation } from './rag.types';
import { novelChapterScope, novelKeywords, novelSourceAllowed, routeIndex } from './rag-policy';

export interface EventRoles { actor: string; recipient?: string | null; action: string; object?: string | null; }
export interface SceneEventCard extends EventRoles {
  id: string; fact: string; quote: string; citation: RagCitation;
  version: 'scene-event-memory-v1'; verification: 'historical_check_only'; storyTime: null;
}

// The independent verifier must explicitly approve event roles. A word match alone never creates a card.
export function sceneEventCard(fact: { text: string; quote: string; event?: EventRoles }, citation: RagCitation,
  neutralSupported: boolean, eventSupported: boolean): SceneEventCard | undefined {
  const e = fact.event;
  if (!neutralSupported || !eventSupported || !e || typeof e.actor !== 'string' || typeof e.action !== 'string') return;
  if (![e.actor, e.action].every(v => v.trim().length > 0 && v.length <= 80 && fact.text.includes(v))) return;
  if ([e.recipient, e.object].some(v => v != null && (typeof v !== 'string' || !v.trim() || v.length > 120 || !fact.text.includes(v)))) return;
  if (typeof fact.quote !== 'string' || fact.quote.length < 8 || fact.quote.length > 160) return;
  return { version: 'scene-event-memory-v1', id: createHash('sha256').update(JSON.stringify([citation.chunkId, e, fact.text])).digest('hex').slice(0, 24),
    actor: e.actor, recipient: e.recipient || null, action: e.action, object: e.object || null,
    fact: fact.text, quote: fact.quote, citation, verification: 'historical_check_only', storyTime: null };
}

export function eventCandidates(context: Array<{ evidence: any }>, question: string, indexVersion: number | null): SceneEventCard[] {
  const scope = novelChapterScope(question), terms = novelKeywords(question);
  const cards = context.flatMap(m => (m.evidence.events || []) as SceneEventCard[]).filter(c =>
    c.citation.indexVersion === indexVersion && novelSourceAllowed(c.citation.chapter, question) &&
    (!scope || scope(c.citation.chapter || '')));
  const unique = [...new Map(cards.map(c => [c.id, c])).values()].reverse();
  // Recency breaks ties; semantic routing subsequently selects a card or explicitly none.
  return unique.sort((a,b)=>terms.filter(t=>b.fact.includes(t)).length-terms.filter(t=>a.fact.includes(t)).length).slice(0, 4);
}
