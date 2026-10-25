// Numeric references are a delivery format, not evidence invented by the model.
// Used only for source-free character dialogue; grounded generation retains its
// separately verified citation manifest and server-assigned labels.
export const SOURCE_FREE_CHARACTER_RULE =
  '\n本轮是没有本轮原文引用的日常角色交谈。历史引用编号只属于各自的旧回答，不沿用或编写 [1]、[2] 等来源标号；' +
  '自然回应即可，不把聊天偏好写成已经核实的原作设定，不向用户复述本条格式约束。';

/** A non-mutating model-view projection, never an edit to saved messages. */
export function citationFreeMemory<T>(value: T): T {
  if (typeof value === 'string') return citationFreeText(value) as T;
  if (Array.isArray(value)) return value.map(citationFreeMemory) as T;
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, citationFreeMemory(item)]),
  ) as T;
  return value;
}

const quotedLiteral: Record<string, string> = { "'": "'", '"': '"', '“': '”', '‘': '’', '「': '」', '『': '』' };
const digit = (char: string | undefined) => !!char && /[0-9０-９]/.test(char);

// This is a lexical delivery guard, not a factual verifier. Code, quoted or
// escaped literals, array indexing and list/link syntax are not citation claims.
// A possible label is held until its disambiguating suffix arrives, so arbitrary
// token boundaries cannot leak a label or change an already-delivered prefix.
function project(text: string, final: boolean): string {
  let result = '', cursor = 0, literalBrackets = 0, code: { delimiter: string; count: number } | undefined;
  while (cursor < text.length) {
    const char = text[cursor];
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    const linePrefix = text.slice(lineStart, cursor);
    if (char === '`' || char === '~' && /^ {0,3}$/.test(linePrefix)) {
      let end = cursor + 1;
      while (text[end] === char) end++;
      if (end === text.length && !final) break;
      const count = end - cursor;
      if (!code && (char === '`' || count >= 3)) code = { delimiter: char, count };
      else if (code?.delimiter === char && (code.count >= 3 ? count >= code.count : count === code.count)) code = undefined;
      result += text.slice(cursor, end); cursor = end; continue;
    }
    if (code) { result += char; cursor++; continue; }
    if (char === '\\') {
      if (cursor + 1 === text.length && !final) break;
      // Consume escaped delimiters together; an even pair of backslashes does
      // not accidentally grant literal status to a following unescaped label.
      result += text.slice(cursor, cursor + 2); cursor += 2; continue;
    }
    const start = cursor, open = text[start];
    const close = open === '[' ? ']' : open === '［' ? '］' : open === '【' ? '】' : undefined;
    if (close) {
      let end = start + 1;
      while (end < text.length && digit(text[end]) && end - start <= 4) end++;
      // Only a short numeric token can be a source label; ordinary bracketed
      // prose and multi-value arrays are not altered.
      if (end - start <= 5 && (end === text.length || text[end] === '\\' && end + 1 === text.length) && !final) break;
      const digits = end - start - 1;
      const escapedClose = text[end] === '\\' && text[end + 1] === close;
      const closing = end + (escapedClose ? 1 : 0);
      if (digits > 0 && digits <= 4 && text[closing] === close) {
        const after = closing + 1;
        if (after === text.length && !final) break;
        const quoted = quotedLiteral[text[cursor - 1]] === text[after] && !!quotedLiteral[text[cursor - 1]];
        // Use the retained prefix: a preceding *removed* [1] cannot turn an
        // adjacent [2] into array indexing by virtue of its closing bracket.
        const indexed = /[A-Za-z0-9_$\])}]/.test(result[result.length - 1] || '');
        let link = open === '[' && (text[after] === '(' || text[after] === ':');
        // Reference-style links with a named key remain links. Adjacent numeric
        // labels such as [1][2] are not treated as a reference-style link.
        if (open === '[' && text[after] === '[') {
          if (after + 1 === text.length && !final) break;
          link = !!text[after + 1] && !digit(text[after + 1]) && !/[\]\s]/.test(text[after + 1]);
        }
        let list = false;
        if (/^ {0,3}(?:[-*+]\s+)?$/.test(linePrefix)) {
          const tail = text.slice(after);
          // A line-initial numeric marker followed by actual item text is a
          // bracket-numbered list, not a trailing source label. Wait for item
          // text when the provider has supplied only its optional separator.
          if (!final && /^[ \t]*(?:[、.)．][ \t]*)?$/.test(tail)) break;
          list = /^[ \t]*(?:[、.)．][ \t]*)?[\p{L}\p{N}]/u.test(tail);
        }
        if (escapedClose || quoted || indexed || literalBrackets > 0 || link || list) {
          result += text.slice(cursor, after); cursor = after; continue;
        }
        cursor = after; continue;
      }
      // Non-numeric brackets include prose and multi-element/nested arrays.
      // Keep enclosed numbers literal rather than removing array elements.
      literalBrackets++;
    }
    if (char === ']' || char === '］' || char === '】') literalBrackets = Math.max(0, literalBrackets - 1);
    result += char; cursor++;
  }
  return result;
}

export function citationFreeText(text: string): string { return project(text, true); }

export class CitationFreeStream {
  private raw = '';
  private delivered = '';

  push(chunk: string, final = false): string {
    this.raw += chunk;
    const text = project(this.raw, final);
    if (!text.startsWith(this.delivered)) throw new Error('Citation projection changed an already delivered prefix');
    const delta = text.slice(this.delivered.length);
    this.delivered = text;
    return delta;
  }

  get content(): string { return this.delivered; }
}
