import { deliverFileOutput, FileOutputStream, FILE_OUTPUT_END, FILE_OUTPUT_START, validateOutputFile, fileDraftHash, FileResume } from './file-output';

const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><canvas></canvas><script>const x=1;</script></body></html>';
const block = (path = 'pelican-bike.html', content = html) => `${FILE_OUTPUT_START}${JSON.stringify({ path })}>>>\n${content}${FILE_OUTPUT_END}`;
const parse = (text: string) => { const stream = new FileOutputStream(); stream.push(text, true); return stream.result(); };
const saved = () => jest.fn().mockResolvedValue({ success: true, result: { proposalId: 7, path: 'pelican-bike.html' } });

describe('declared create-only file output', () => {
  test('ordinary code examples are never scraped or saved', async () => {
    const text = '例如：\n```html\n<div>hello</div>\n```', stream = new FileOutputStream(), save = saved();
    expect(stream.push(text)).toBe(text); stream.push('', true);
    expect(await deliverFileOutput(stream.result(), 'stop', {}, save)).toEqual({ content: text, incomplete: false, paths: [] });
    expect(save).not.toHaveBeenCalled();
  });
  test('every possible two-chunk boundary hides headers and file content while preserving prose', () => {
    const input = '开始\n' + block() + '\n完成';
    for (let split = 0; split <= input.length; split++) {
      const stream = new FileOutputStream();
      const visible = stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.push('', true);
      expect(visible).toBe('开始\n');
      expect(stream.result()).toEqual({ text: '开始\n\n完成', emittedText: '开始\n', files: [{ path: 'pelican-bike.html', content: html }],
        incomplete: false, paths: ['pelican-bike.html'], declared: true, draft: { path: 'pelican-bike.html', content: html, closed: true } });
    }
  });
  test('single-character and linewise streams produce exactly the declared file', () => {
    for (const chunks of [Array.from(block()), block().match(/[^\n]*\n|[^\n]+$/g)!]) {
      const stream = new FileOutputStream();
      expect(chunks.map(chunk => stream.push(chunk)).join('') + stream.push('', true)).toBe('');
      expect(stream.result().files).toEqual([{ path: 'pelican-bike.html', content: html }]);
    }
  });
  test('only a complete stop persists a new immutable proposal, not a workspace write', async () => {
    const save = saved(), context = { userId: 9, conversationId: 18 };
    expect(await deliverFileOutput(parse(block()), 'stop', context, save)).toEqual({ content: '文件已生成。', incomplete: false, paths: ['pelican-bike.html'] });
    expect(save).toHaveBeenCalledWith({ action: 'propose', path: 'pelican-bike.html', content: html, expectedRevision: 0,
      description: '生成独立文件 pelican-bike.html' }, context);
  });
  test.each(['length', 'content_filter', null])('even a closed block cannot become a complete artifact after %s', async reason => {
    const save = saved();
    expect(await deliverFileOutput(parse(block()), reason, {}, save)).toMatchObject({ incomplete: true });
    expect(save).not.toHaveBeenCalled();
  });
  test.each([
    `${FILE_OUTPUT_START}{"path":"pelican-bike.html"}>>>\n${html.slice(0, -20)}`,
    '<<<CHATFORUM_FI',
    `${FILE_OUTPUT_START}{"path":"../escape.html"}>>>\n${html}${FILE_OUTPUT_END}`,
    `${FILE_OUTPUT_START}{"path":"a.html","action":"write"}>>>\n${html}${FILE_OUTPUT_END}`,
    block('bad.html', '<!doctype html><html><body><script>if (e.code ===</script></body></html>'),
    block('big.txt', '🌸'.repeat(17000)),
    block('same.txt', 'one') + block('SAME.txt', 'two'),
  ])('malformed, oversized, incomplete or invalid JavaScript output never produces an artifact', async input => {
    const save = saved();
    const result = await deliverFileOutput(parse(input), 'stop', {}, save);
    expect(result.incomplete).toBe(true); expect(result.content).not.toContain('<<<');
    expect(save).not.toHaveBeenCalled();
  });
  test('persistence failure cannot claim a completed download or overwrite an existing file', async () => {
    const save = jest.fn().mockResolvedValue({ success: false, result: { error: '版本不匹配' } });
    const result = await deliverFileOutput(parse(block()), 'stop', {}, save);
    expect(result).toMatchObject({ incomplete: true }); expect(result.content).toContain('未被覆盖');
    expect(save.mock.calls[0][0].expectedRevision).toBe(0);
  });
  test.each(['stop', 'length'])('a long already-emitted prefix is preserved before actual delivery status, finish=%s', async reason => {
    const prefix = '这是页面的说明文字。'.repeat(100), stream = new FileOutputStream(), save = saved();
    const emitted = stream.push(prefix.slice(0, 37)) + stream.push(prefix.slice(37) + block()) + stream.push('', true);
    expect(emitted).toBe(prefix); expect(stream.result().emittedText).toBe(emitted);
    const result = await deliverFileOutput(stream.result(), reason, {}, save);
    expect(result.content.startsWith(emitted + '\n\n')).toBe(true);
    expect(emitted + result.content.slice(emitted.length)).toBe(result.content);
    expect(result.incomplete).toBe(reason !== 'stop');
  });
  test('failure with no complete file preserves the visible prefix and does not publish private source', async () => {
    const prefix = '开始生成。\n', stream = new FileOutputStream(), save = saved();
    const emitted = stream.push(prefix + block().slice(0, -15)) + stream.push('', true);
    const result = await deliverFileOutput(stream.result(), 'length', {}, save);
    expect(result.content).toBe(prefix + '\n文件尚未生成完整，本次输出已达上限，可继续生成。');
    expect(result.content.startsWith(emitted)).toBe(true); expect(result.content).not.toContain('<script>');
    expect(save).not.toHaveBeenCalled();
  });
  test('HTML syntax checks compile but do not execute script', () => {
    const marker = jest.fn(); (globalThis as any).__fileOutputExecuted = marker;
    try { validateOutputFile({ path: 'a.html', content: html.replace('const x=1;', 'globalThis.__fileOutputExecuted();') }); expect(marker).not.toHaveBeenCalled(); }
    finally { delete (globalThis as any).__fileOutputExecuted; }
  });
  test('cancelled output is not persisted', async () => {
    const controller = new AbortController(), save = saved(); controller.abort();
    await expect(deliverFileOutput(parse(block()), 'stop', { signal: controller.signal }, save)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});

const resumeBase = (content: string, closed = false, path = 'pelican-bike.html'): FileResume => ({ path, content, closed, hash: fileDraftHash(content) });
const resumeBlock = (base: FileResume, content: string, operation = base.closed ? 'patch' : 'append', close = true,
  override: Record<string, unknown> = {}) => `${FILE_OUTPUT_START}${JSON.stringify({ path: base.path, baseHash: base.hash, operation, ...override })}>>>\n${content}${close ? FILE_OUTPUT_END : ''}`;
const parseResume = (base: FileResume, text: string) => { const stream = new FileOutputStream(base); stream.push(text, true); return stream.result(); };

describe('private file checkpoints and exact resume', () => {
  test('an unfinished initial stream retains only source bytes for checkpointing, including at final length', async () => {
    const prefix = html.slice(0, html.indexOf('const x=') + 'const x='.length), stream = new FileOutputStream();
    expect(stream.push('先写页面。' + block('pelican-bike.html', prefix).slice(0, -FILE_OUTPUT_END.length))).toBe('先写页面。');
    expect(stream.draft()).toEqual({ path: 'pelican-bike.html', content: prefix, closed: false });
    expect(JSON.stringify(stream.draft())).not.toContain('先写页面'); stream.push('', true);
    const result = await deliverFileOutput(stream.result(), 'length', {}, saved());
    expect(result).toMatchObject({ reason: 'OUTPUT_LIMIT', incomplete: true, draft: { path: 'pelican-bike.html', content: prefix, closed: false } });
    expect(result.content).not.toContain(prefix);
  });
  test('a closed block cut off during commentary remains a closed private draft', async () => {
    const result = await deliverFileOutput(parse(block()), 'length', {}, saved());
    expect(result).toMatchObject({ reason: 'OUTPUT_LIMIT', draft: { content: html, closed: true } });
  });
  test('every resume chunk boundary reconstructs exact prefix+suffix with no source sent as text', async () => {
    const split = html.indexOf('const x=') + 'const x='.length, base = resumeBase(html.slice(0, split)), suffix = html.slice(split);
    const wire = resumeBlock(base, suffix);
    for (let n = 0; n <= wire.length; n++) {
      const stream = new FileOutputStream(base);
      expect(stream.push(wire.slice(0, n)) + stream.push(wire.slice(n)) + stream.push('', true)).toBe('');
      expect(stream.result().files).toEqual([{ path: base.path, content: base.content + suffix }]);
      expect(stream.draft()).toEqual({ path: base.path, content: html, closed: true });
    }
    const save = saved(); await deliverFileOutput(parseResume(base, wire), 'stop', {}, save);
    expect(save.mock.calls[0][0].content).toBe(html);
  });
  test('two length-limited pieces resume the saved byte boundary instead of restarting', async () => {
    const split = html.indexOf('const x=') + 'const x='.length, prefix = html.slice(0, split), tail = html.slice(split);
    const first = parse(block('pelican-bike.html', prefix).slice(0, -FILE_OUTPUT_END.length));
    const firstResult = await deliverFileOutput(first, 'length', {}, saved());
    const base1 = resumeBase(firstResult.draft!.content), continuation1 = tail.slice(0, 2);
    const second = parseResume(base1, resumeBlock(base1, continuation1, 'append', false));
    const secondResult = await deliverFileOutput(second, 'length', {}, saved());
    expect(secondResult).toMatchObject({ reason: 'OUTPUT_LIMIT', draft: { content: prefix + continuation1, closed: false } });
    const base2 = resumeBase(secondResult.draft!.content);
    const final = parseResume(base2, resumeBlock(base2, tail.slice(continuation1.length)));
    const save = saved(); expect(await deliverFileOutput(final, 'stop', {}, save)).toMatchObject({ incomplete: false });
    expect(save.mock.calls[0][0].content).toBe(prefix + tail); expect(save).toHaveBeenCalledTimes(1);
  });
  test.each([
    { baseHash: '0'.repeat(64) }, { path: 'another.html' }, { operation: 'patch' }, { action: 'write' },
  ])('mismatched resume authority rejects the turn without changing the original draft: %j', async override => {
    const base = resumeBase(html.slice(0, -20)), output = parseResume(base, resumeBlock(base, 'suffix', 'append', true, override));
    const save = saved(), result = await deliverFileOutput(output, 'stop', {}, save);
    expect(result).toMatchObject({ reason: 'INVALID_FILE', draft: { path: base.path, content: base.content, closed: false } });
    expect(output.files).toEqual([]); expect(save).not.toHaveBeenCalled();
  });
  test('invalid saved hash or unsafe saved path is not accepted as a resume base', () => {
    expect(() => new FileOutputStream({ ...resumeBase(html), hash: '0'.repeat(64) })).toThrow('INVALID_FILE');
    expect(() => new FileOutputStream(resumeBase(html, false, '../file.html'))).toThrow('INVALID_FILE');
  });
  test.each([html, ' \n<!doctype html><html>', html.slice(0, -20)])('doctype/full-prefix restart never pollutes a checkpoint', async suffix => {
    const base = resumeBase(html.slice(0, -20)), stream = new FileOutputStream(base);
    const wire = resumeBlock(base, suffix);
    for (const character of wire) {
      stream.push(character);
      expect(stream.draft()).toEqual({ path: base.path, content: base.content, closed: false });
    }
    stream.push('', true); const save = saved();
    expect(await deliverFileOutput(stream.result(), 'stop', {}, save)).toMatchObject({ reason: 'INVALID_FILE', draft: { content: base.content } });
    expect(save).not.toHaveBeenCalled();
  });
  test('closed HTML syntax failures preserve a repairable draft and report the actual failure stage', async () => {
    const invalid = html.replace('const x=1;', 'if (e.code ==='), result = await deliverFileOutput(parse(block('bad.html', invalid)), 'stop', {}, saved());
    expect(result).toMatchObject({ reason: 'HTML_SYNTAX', draft: { path: 'bad.html', content: invalid, closed: true } });
  });
  test('exact local patches fix a closed syntax-error draft without executing code', async () => {
    const bad = html.replace('const x=1;', 'if (e.code ==='), base = resumeBase(bad, true);
    const patch = JSON.stringify({ edits: [{ oldText: 'if (e.code ===', newText: 'const x=1;' }] });
    const stream = new FileOutputStream(base), wire = resumeBlock(base, patch);
    stream.push(wire.slice(0, wire.length - 1));
    expect(stream.draft()).toEqual({ path: base.path, content: bad, closed: true });
    stream.push(wire.slice(-1), true); expect(stream.draft()).toEqual({ path: base.path, content: html, closed: true });
    const save = saved(); expect(await deliverFileOutput(stream.result(), 'stop', {}, save)).toMatchObject({ incomplete: false });
    expect(save.mock.calls[0][0].content).toBe(html);
  });
  test('a partial patch limited midway retains the original source, never patch JSON', async () => {
    const base = resumeBase(html, true), partial = '{"edits":[{"oldText":"const x=1;","newText":"';
    const output = parseResume(base, resumeBlock(base, partial, 'patch', false));
    expect(await deliverFileOutput(output, 'length', {}, saved())).toMatchObject({ reason: 'OUTPUT_LIMIT', draft: { content: html, closed: true } });
    expect(output.draft!.content).not.toContain('"edits"');
  });
  test.each([
    { edits: [{ oldText: '', newText: 'oops' }] },
    { edits: [{ oldText: 'missing', newText: 'oops' }] },
    { edits: [{ oldText: 'const x=1;', newText: 'const x=2;' }, { oldText: 'missing', newText: 'oops' }] },
    { edits: Array.from({ length: 9 }, () => ({ oldText: 'x', newText: 'y' })) },
    { edits: [], action: 'write' },
  ])('invalid patches are atomic and retain the original base: %j', async patch => {
    const base = resumeBase(html, true), save = saved();
    expect(await deliverFileOutput(parseResume(base, resumeBlock(base, JSON.stringify(patch))), 'stop', {}, save))
      .toMatchObject({ reason: 'INVALID_FILE', draft: { content: html, closed: true } });
    expect(save).not.toHaveBeenCalled();
  });
  test('a non-unique patch fragment cannot replace one arbitrary occurrence', async () => {
    const base = resumeBase(html.replace('<canvas></canvas>', '<p>same</p><p>same</p>'), true);
    const output = parseResume(base, resumeBlock(base, JSON.stringify({ edits: [{ oldText: '<p>same</p>', newText: 'changed' }] })));
    expect(await deliverFileOutput(output, 'stop', {}, saved())).toMatchObject({ reason: 'INVALID_FILE', draft: { content: base.content } });
  });
  test('empty patch acknowledges an already-complete closed source without regenerating it', async () => {
    const base = resumeBase(html, true), save = saved();
    expect(await deliverFileOutput(parseResume(base, resumeBlock(base, '{"edits":[]}')), 'stop', {}, save)).toMatchObject({ incomplete: false });
    expect(save.mock.calls[0][0].content).toBe(html);
  });
  test('a complete source missing only its frame terminator may append no bytes and close normally', async () => {
    const base = resumeBase(html, false), save = saved();
    expect(await deliverFileOutput(parseResume(base, resumeBlock(base, '')), 'stop', {}, save)).toMatchObject({ incomplete: false });
    expect(save.mock.calls[0][0].content).toBe(html);
  });
  test('checkpoint snapshots are isolated from caller mutation and never include a partial end delimiter', () => {
    const stream = new FileOutputStream();
    stream.push(block('a.txt', 'saved prefix').slice(0, -FILE_OUTPUT_END.length) + FILE_OUTPUT_END.slice(0, 11));
    const checkpoint = stream.draft()!; expect(checkpoint).toEqual({ path: 'a.txt', content: 'saved prefix', closed: false });
    checkpoint.content = 'caller changed'; checkpoint.path = 'another.txt';
    expect(stream.draft()).toEqual({ path: 'a.txt', content: 'saved prefix', closed: false });
    stream.push('', true); expect(stream.result().draft).toEqual({ path: 'a.txt', content: 'saved prefix', closed: false });
  });
  test('append capacity failures and missing resume headers keep the old private source', async () => {
    const base = resumeBase('a'.repeat(63999), false, 'a.txt');
    const oversized = parseResume(base, resumeBlock(base, '🌸'));
    expect(await deliverFileOutput(oversized, 'stop', {}, saved())).toMatchObject({ reason: 'INVALID_FILE', draft: { content: base.content } });
    const plain = parseResume(base, '我重新写一个吧。');
    expect(await deliverFileOutput(plain, 'stop', {}, saved())).toMatchObject({ reason: 'INVALID_FILE', draft: { content: base.content } });
  });
  test('unfinished blocks and failed saving have distinct reasons and keep their safe source', async () => {
    const unfinished = parse(block('a.txt', 'half source').slice(0, -FILE_OUTPUT_END.length));
    expect(await deliverFileOutput(unfinished, 'stop', {}, saved())).toMatchObject({ reason: 'UNCLOSED_FILE', draft: { content: 'half source', closed: false } });
    const save = jest.fn().mockRejectedValue(new Error('storage down'));
    expect(await deliverFileOutput(parse(block()), 'stop', {}, save)).toMatchObject({ reason: 'SAVE_FAILED', draft: { content: html, closed: true } });
  });
  test('cancelled patch delivery never saves, and interrupted patch parsing retains the base', async () => {
    const base = resumeBase(html, true), stream = new FileOutputStream(base), controller = new AbortController();
    stream.push(resumeBlock(base, '{"edits":[', 'patch', false));
    controller.abort(); stream.push('', true); const save = saved();
    await expect(deliverFileOutput(stream.result(), 'length', { signal: controller.signal }, save)).rejects.toThrow();
    expect(stream.draft()).toEqual({ path: base.path, content: html, closed: true }); expect(save).not.toHaveBeenCalled();
  });
});
