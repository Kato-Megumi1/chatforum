export const NOVEL_GRAPH_VERSION = 'scene-evidence-graph-v2';
// Alias resolution only. No role, romance, kinship or personality facts are seeded.
export const NOVEL_ENTITIES = [
  { key: 'megumi', name: '加藤惠', aliases: ['加藤惠', '加藤', '惠'] },
  { key: 'tomoya', name: '安艺伦也', aliases: ['安艺伦也', '安艺', '伦也', 'taki'] },
  { key: 'eriri', name: '英梨梨', aliases: ['英梨梨', '柏木英理'] },
  { key: 'utaha', name: '霞丘诗羽', aliases: ['霞丘诗羽', '霞之丘诗羽', '霞ケ丘诗羽', '诗羽', '霞诗子'] },
  { key: 'michiru', name: '冰堂美智留', aliases: ['冰堂美智留', '美智留'] },
  { key: 'iori', name: '波岛伊织', aliases: ['波岛伊织', '伊织'] },
  { key: 'izumi', name: '波岛出海', aliases: ['波岛出海', '出海'] },
  { key: 'machida', name: '町田苑子', aliases: ['町田苑子', '町田'] },
  { key: 'akane', name: '红坂朱音', aliases: ['红坂朱音', '红坂', '朱音'] },
  { key: 'blessing', name: 'blessing software', aliases: ['blessing software'] },
  { key: 'rouge', name: 'rouge en rouge', aliases: ['rouge en rouge'] },
  { key: 'icy', name: 'icy tail', aliases: ['icy tail'] },
];
export const GRAPH_PREDICATES = ['ROLE', 'MEMBER_OF', 'ADDRESS', 'KINSHIP', 'CREATED', 'ACTION', 'FEELING'] as const;
export const normalizeEntityText = (s: string) => s.normalize('NFKC').toLowerCase();
export function mentionedEntities(text: string): string[] {
  const normalized = normalizeEntityText(text);
  return NOVEL_ENTITIES.filter(e => e.aliases.some(a => a.length > 1 ? normalized.includes(a) :
    new RegExp('(?:^|[,.;:!?，。！？、：；「」『』“”\\s])' + a + '(?=$|[,.;:!?，。！？、：；「」『』“”\\s])').test(normalized))).map(e => e.key);
}
export interface ExtractedGraphFact {
  subject: string; predicate: string; target?: string | null; object: string;
  sourceId: number; quote: string; speaker?: string | null;
}
export function validateGraphFacts(value: unknown, passages: Array<{ content: string }>): ExtractedGraphFact[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid graph fact batch');
  const keys = new Set(mentionedEntities(passages.map(p => p.content).join('\n')));
  return value.filter((f): f is ExtractedGraphFact => !!f && keys.has(f.subject) &&
    GRAPH_PREDICATES.includes(f.predicate) && (!f.target || keys.has(f.target)) &&
    (!f.speaker || keys.has(f.speaker)) && Number.isInteger(f.sourceId) && f.sourceId > 0 && f.sourceId <= passages.length &&
    typeof f.object === 'string' && f.object.trim().length > 0 && f.object.length <= 200 &&
    typeof f.quote === 'string' && f.quote.trim().length >= 8 && f.quote.length <= 240 &&
    passages[f.sourceId - 1].content.includes(f.quote));
}
