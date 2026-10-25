import { CitationFreeStream, citationFreeMemory, citationFreeText } from './citation-authority';

const cases: Array<[string, string]> = [
  ['今天想去看电影。 [1]\n还想散步。[2]', '今天想去看电影。 \n还想散步。'],
  ['今天想去散步。[1][2]［３］【4】', '今天想去散步。'],
  ["字面量 '[1]'、“［1］”和「【2】」都不是来源。 [3]", "字面量 '[1]'、“［1］”和「【2】」都不是来源。 "],
  ['转义形式 \\[1\\]、\\[2] 和 [3\\] 应原样保留。 [4]', '转义形式 \\[1\\]、\\[2] 和 [3\\] 应原样保留。 '],
  ['数组 array[1]、data.items[2]、values[0]，结果不是证据。 [3]', '数组 array[1]、data.items[2]、values[0]，结果不是证据。 '],
  ['多值数组 [1, 2]；嵌套 [[1], [2, [3]]]。 [4]', '多值数组 [1, 2]；嵌套 [[1], [2, [3]]]。 '],
  ['[1] 第一项\n[2]第二项\n  [3]、第三项\n- [4] fourth\n末尾来源 [5]', '[1] 第一项\n[2]第二项\n  [3]、第三项\n- [4] fourth\n末尾来源 '],
  ['代码 `arr[1]`、`` [2] ``；普通正文 [3]', '代码 `arr[1]`、`` [2] ``；普通正文 '],
  ['```ts\nconst x = [1];\narr[2];\n```\n正文 [3]', '```ts\nconst x = [1];\narr[2];\n```\n正文 '],
  ['  ~~~txt\n[1]\n  ~~~\n正文 [2]', '  ~~~txt\n[1]\n  ~~~\n正文 '],
  ['[1](https://example.test/a) 和 ![2](fixture.png) 及 [3][source]\n[3]: https://example.test/b\n正文 [4]', '[1](https://example.test/a) 和 ![2](fixture.png) 及 [3][source]\n[3]: https://example.test/b\n正文 '],
  ['不完整标记 [ 和 [12', '不完整标记 [ 和 [12'],
  ['超过短编号边界的 [12345] 原样保留。 [1]', '超过短编号边界的 [12345] 原样保留。 '],
];

describe('source-free roleplay citation delivery projection', () => {
  test.each(cases)('removes unsupported footnotes, preserving literal syntax: %s', (source, expected) => {
    expect(citationFreeText(source)).toBe(expected);
  });

  test.each(cases)('stream projection is prefix-stable across every split: %s', (source, expected) => {
    for (let split = 0; split <= source.length; split++) {
      const stream = new CitationFreeStream();
      const pieces = [stream.push(source.slice(0, split)), stream.push(source.slice(split)), stream.push('', true)];
      expect(pieces.join('')).toBe(expected);
      expect(stream.content).toBe(expected);
    }
    const stream = new CitationFreeStream();
    let delivered = '';
    for (const char of source) delivered += stream.push(char);
    delivered += stream.push('', true);
    expect(delivered).toBe(expected);
    expect(stream.content).toBe(expected);
  });

  test('split unsupported labels never appear in an intermediate payload', () => {
    const stream = new CitationFreeStream();
    let delivered = '';
    for (const chunk of ['电影。 ', '[', '1', ']', '[', '2', ']', '\n散步。', '［', '３', '］']) {
      delivered += stream.push(chunk);
      expect(delivered).not.toMatch(/[\[［【][0-9０-９]+[\]］】]/);
    }
    delivered += stream.push('', true);
    expect(delivered).toBe('电影。 \n散步。');
  });

  test('memory projection is immutable and leaves literal examples intact', () => {
    const source = { summary: { user: "请解释 '[1]'。", assistant: '此前想散步。 [1]' },
      excerpts: [{ messageId: 7, content: '数组 arr[1]。 [2]' }], sourceIds: [7], omitted: null };
    const before = structuredClone(source);
    const projected = citationFreeMemory(source);
    expect(source).toEqual(before);
    expect(projected).toEqual({ summary: { user: "请解释 '[1]'。", assistant: '此前想散步。 ' },
      excerpts: [{ messageId: 7, content: '数组 arr[1]。 ' }], sourceIds: [7], omitted: null });
    expect(projected).not.toBe(source);
  });
});
