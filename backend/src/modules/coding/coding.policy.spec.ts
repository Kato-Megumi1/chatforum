import { attachmentArgs, codeArgs, codePath, codeText, replaceExact } from './coding.policy';
import { CodingSkill } from '../agent/skills/coding.skill';

describe('private coding workspace boundaries', () => {
  test('portable relative text paths only', () => {
    expect(codePath('src/示例.ts')).toBe('src/示例.ts');
    for (const path of ['../x.ts', '/x.ts', 'C:/x.ts', 'a\\x.ts', '.env', '.git/config.txt', 'src/../x.ts', 'a//x.ts',
      'CON.js', 'a/nul.txt', 'node_modules/a.js', 'storage/a.txt', 'x.exe', 'a /x.ts', 'a\0.ts']) expect(() => codePath(path)).toThrow();
  });
  test('UTF-8 size, binary and obvious credentials are rejected', () => {
    expect(codeText('你好')).toBe('你好');
    for (const text of ['a\0b', '中'.repeat(22000), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'sk-' + 'x'.repeat(32)]) expect(() => codeText(text)).toThrow();
  });
  test('exact edits need one unambiguous occurrence; no fuzzy replacement', () => {
    expect(replaceExact('a\n你好\nb', '你好', 'hello')).toBe('a\nhello\nb');
    for (const search of ['', 'missing', 'a']) expect(() => replaceExact('a a', search, 'x')).toThrow();
  });
  test('tool schema cannot request execution, approval or another user/workspace', () => {
    expect(codeArgs.parse({ action: 'list' })).toEqual({ action: 'list' });
    for (const action of ['exec', 'apply', 'delete', 'shell']) expect(codeArgs.safeParse({ action }).success).toBe(false);
    for (const field of ['userId', 'conversationId', 'command']) expect(codeArgs.safeParse({ action: 'list', [field]: 1 }).success).toBe(false);
    const tool = new CodingSkill({} as any).tool;
    expect(tool.parameters.required).toEqual(['action']);
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(Object.keys(attachmentArgs.shape).sort());
    expect(tool.parameters.properties.action.enum).not.toContain('write');
  });
});
