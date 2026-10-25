import { Prisma } from '@prisma/client';

export const FORUM_HOT_FORMULA = '(likes*3+comments*2+views*0.1)/(ageHours+2)^1.5';
export function forumHotScore(asOf: Date) {
  return Prisma.sql`(p.likeCount*3+p.commentCount*2+p.viewCount*0.1)/POW(GREATEST(0,TIMESTAMPDIFF(SECOND,p.createdAt,${asOf})/3600)+2,1.5)`;
}

/** Values remain parameters. Boolean operators are generated, never taken from user text.
 * One-character / Latin / punctuation terms use literal LOCATE (not LIKE wildcards),
 * because default MySQL ngram stopwords can drop even tokens inside "AI"/"OpenAI".
 * Chinese terms use the index; all terms must match, with no query operators accepted.
 */
export function forumSearchClauses(query?: string): Prisma.Sql[] {
  return (query?.trim().split(/\s+/).filter(Boolean) || []).map(term => {
    if (/^[\p{Script=Han}\p{N}]+$/u.test(term) && [...term].length >= 2)
      return Prisma.sql`MATCH(p.title,p.content) AGAINST(${`+"${term}"`} IN BOOLEAN MODE)`;
    return Prisma.sql`(LOCATE(${term},p.title)>0 OR LOCATE(${term},p.content)>0)`;
  });
}

export function forumSummary(content: string) {
  return content.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ').replace(/[`#*_>~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}
