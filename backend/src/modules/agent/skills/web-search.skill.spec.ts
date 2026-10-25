import { WebSearchSkill, parseSearchHtml, readSearchHtml, webSourceUrl } from './web-search.skill';
import { SkillRegistry } from './skill.registry';
import { responseSkills } from '../../chat/chat-response-options';
const ddg = '<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fone%3Fa%3D1%26b%3D2">第一 &amp; 条</a><a class="result__snippet">摘要<b>一</b></a></div>' +
  '<div class="result results_links"><a class="result__a" href="https://example.org/two">第二条</a><a class="result__snippet">摘要二</a></div>';
const bing = '<li class="b_algo"><h2><a href="https://example.org/bing">Bing来源</a></h2><p>真实摘要</p></li>';
describe('explicit public web search', () => {
  test('ordinary and Agent search permissions are separate from tool checkboxes and default tool lists', () => {
    expect(responseSkills({ mode: 'normal', enabledSkills: ['web_search', 'calculator', 'code_workspace'] })).toEqual(['code_workspace']);
    expect(responseSkills({ mode: 'agent', enabledSkills: ['web_search', 'calculator'], webSearch: false })).toEqual(['calculator']);
    expect(responseSkills({ mode: 'normal', webSearch: true }, ['calculator'])).toEqual(['web_search']);
    expect(responseSkills({ mode: 'agent', webSearch: true }, ['web_search', 'calculator'])).toEqual(['calculator', 'web_search']);
  });
  test('registry and direct skill calls both fail closed when the switch is absent', async () => {
    const read = jest.fn(), skill = new WebSearchSkill(read);
    SkillRegistry.register(skill, { name: 'web_search', description: '', category: 'tool', enabled: true });
    expect(SkillRegistry.getOpenAIFunctions(['web_search'])).toEqual([]);
    expect(SkillRegistry.getLangChainTools(['web_search'])).toEqual([]);
    expect(SkillRegistry.getLangChainTools(['web_search'], undefined, { webSearch: true })).toHaveLength(1);
    expect(await skill.execute({ query: '天气' }, {})).toMatchObject({ success: false });
    expect(read).not.toHaveBeenCalled();
  });
  test('DDG titles, URLs and snippets stay in the same block; redirect wrappers are decoded', () => {
    expect(parseSearchHtml(ddg, 'DuckDuckGo', 5)).toEqual([
      { title: '第一 & 条', url: 'https://example.org/one?a=1&b=2', snippet: '摘要一' },
      { title: '第二条', url: 'https://example.org/two', snippet: '摘要二' },
    ]);
    expect(parseSearchHtml(bing, 'Bing', 1)[0]).toMatchObject({ title: 'Bing来源', url: 'https://example.org/bing' });
    const wrapped = 'https://www.bing.com/ck/a?u=a1' + Buffer.from('https://example.org/decoded').toString('base64url');
    expect(webSourceUrl(wrapped)).toBe('https://example.org/decoded');
  });
  test.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:secret@example.org/',
    'http://127.0.0.1/a', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://192.168.1.1/', 'http://198.18.1.1/', 'http://localhost/', 'http://localhost./', 'http://metadata.internal./',
    'http://router.lan./', 'http://metadata.internal/', '/relative'])('rejects unsafe source %s', value => {
    expect(webSourceUrl(value)).toBeUndefined();
  });
  test('empty challenge pages fall back; only observed sources are shared with this task', async () => {
    const read = jest.fn().mockResolvedValueOnce('<html>captcha</html>').mockResolvedValueOnce(bing);
    const sources = [], failures = [], signal = new AbortController().signal;
    const reply = await new WebSearchSkill(read).execute({ query: '公开关键词' }, { webSearch: true, webSources: sources, webSearchFailures: failures, signal });
    expect(reply).toMatchObject({ success: true, modelData: { kind: 'search_snippets_not_full_pages', sources } });
    expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls.every(c => c[1] === signal)).toBe(true);
    expect(sources).toHaveLength(1); expect(failures).toEqual([]);
  });
  test('blocked engines are errors, not fabricated empty search success; cancellation never falls back', async () => {
    const failures = [], skill = new WebSearchSkill(jest.fn().mockResolvedValue('<html>challenge</html>'));
    expect(await skill.execute({ query: '公开查询' }, { webSearch: true, webSearchFailures: failures })).toMatchObject({ success: false, result: null });
    expect(failures).toEqual(['SEARCH_UNAVAILABLE']);
    const controller = new AbortController(); controller.abort(); const read = jest.fn();
    await expect(new WebSearchSkill(read).execute({ query: '公开查询' }, { webSearch: true, signal: controller.signal })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  test.each([{ query: '' }, { query: 'x'.repeat(241) }, { query: 'x', num_results: 100 }, { query: 'x', num_results: 1.2 }])('validates bounded public query before network', async args => {
    const read = jest.fn(); expect(await new WebSearchSkill(read).execute(args, { webSearch: true })).toMatchObject({ success: false }); expect(read).not.toHaveBeenCalled();
  });
  test('transport rejects arbitrary hosts/ports before any request or DNS', async () => {
    for (const url of ['http://www.bing.com/', 'https://example.org/', 'https://www.bing.com:8443/', 'https://user:pass@www.bing.com/'])
      await expect(readSearchHtml(new URL(url))).rejects.toThrow('Search host rejected');
  });
});
