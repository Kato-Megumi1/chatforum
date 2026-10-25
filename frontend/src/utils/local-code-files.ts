// Only directory handles selected by the user enter this adapter. No host/server paths.
export const FILE_BYTES = 64000;
export function localPath(path: string) {
  if (!path || path.length > 180 || path !== path.normalize('NFC') || /[\\:<>"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(path) ||
    path.split('/').some(s => !s || s.startsWith('.') || /[ .]$/.test(s) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(s) ||
      /^(?:node_modules|storage|uploads|dist|vendor|credentials?|secrets?)(?:\.|$)/i.test(s)) ||
    !/\.(js|jsx|ts|tsx|cjs|mjs|json|vue|html|css|scss|md|txt|py|java|go|rs|sql|yml|yaml|toml)$/i.test(path)) throw Error('禁止访问隐藏文件、凭据、依赖或目录外路径；仅支持代码文本');
  return path;
}
export function localText(text: string) {
  if (text.includes('\0') || new TextEncoder().encode(text).length > FILE_BYTES) throw Error('仅支持64KB以内的UTF-8文本文件');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{24,}/.test(text)) throw Error('检测到疑似密钥，拒绝读取或写入');
  return text;
}
export async function textHash(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export class LocalCodeFiles {
  constructor(private root: any, private allowed: () => boolean = () => true) {}
  private async guard() {
    if (!this.allowed() || await this.root.queryPermission({ mode: 'readwrite' }) !== 'granted') throw Error('本机工作区未连接或授权已撤销');
  }
  private async handle(path: string, create = false) {
    localPath(path); await this.guard();
    const parts = path.split('/'), name = parts.pop()!;
    let dir = this.root;
    for (const part of parts) { await this.guard(); dir = await dir.getDirectoryHandle(part, { create }); }
    await this.guard();
    return dir.getFileHandle(name, { create });
  }
  private async read(path: string) {
    const handle = await this.handle(path), file = await handle.getFile();
    if (file.size > FILE_BYTES) throw Error('文件超过64KB，请拆分后处理');
    const content = localText(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
    return { handle, content, hash: await textHash(content) };
  }
  async list() {
    await this.guard();
    const paths: string[] = []; let visited = 0, truncated = false;
    const walk = async (dir: any, prefix: string, depth: number) => {
      if (depth > 12) { truncated = true; return; }
      for await (const [name, handle] of dir.entries()) {
        if (++visited > 2000) { truncated = true; break; }
        const path = prefix + name;
        try { localPath(handle.kind === 'directory' ? path + '/check.txt' : path); } catch { continue; }
        if (handle.kind === 'directory') await walk(handle, path + '/', depth + 1); else paths.push(path);
      }
    };
    await walk(this.root, '', 0); await this.guard();
    return { paths: paths.sort(), truncated };
  }
  async execute(args: any, beforeWrite: () => Promise<void> = async () => {}) : Promise<Record<string, any>> {
    await this.guard();
    if (args.action === 'list') {
      const { paths, truncated } = await this.list(), start = Math.max(0, (args.startLine || 1) - 1);
      return { files: paths.slice(start, start + 150).map(path => ({ path })), nextLine: paths.length > start + 150 ? start + 151 : null, truncated };
    }
    if (args.action === 'search') {
      if (typeof args.query !== 'string' || !args.query || args.query.length > 100) throw Error('搜索词无效');
      const { paths, truncated } = await this.list(), hits: any[] = []; let inspected = 0, skipped = 0;
      const candidates = args.path ? [localPath(args.path)] : paths;
      for (const path of candidates) {
        if (inspected >= 100 || hits.length >= 30) break;
        inspected++;
        try { const { content } = await this.read(path); content.split('\n').forEach((line, i) => { if (line.includes(args.query) && hits.length < 30) hits.push({ path, line: i + 1, text: line.slice(0, 240) }); }); } catch { skipped++; }
      }
      return { hits, inspected, skipped, truncated: truncated || inspected < candidates.length, note: '字面搜索有范围限制；可指定path进一步查询' };
    }
    const path = localPath(args.path);
    if (args.action === 'read' || args.action === 'check') {
      const { content, hash } = await this.read(path);
      if (args.action === 'check') {
        if (!path.endsWith('.json')) return { path, checked: false, note: '浏览器不执行代码；仅支持JSON语法检查' };
        JSON.parse(content); return { path, checked: true, check: 'JSON语法；未执行代码或项目测试' };
      }
      const lines = content.split('\n'), start = Math.max(0, (args.startLine || 1) - 1);
      const selected: string[] = []; let length = 0;
      for (let i = start; i < Math.min(start + 120, lines.length); i++) {
        const line = `${i + 1}: ${lines[i]}`;
        if (length + line.length > 12000) break;
        selected.push(line); length += line.length + 1;
      }
      if (!selected.length && start < lines.length) throw Error('单行过长，请先拆分该文件');
      return { path, hash, content: selected.join('\n'), totalLines: lines.length, nextLine: start + selected.length < lines.length ? start + selected.length + 1 : null };
    }
    if (args.action !== 'write') throw Error('本机工作区请使用write，不支持删除、终端或云端提案');
    if (!/^(absent|[a-f0-9]{64})$/.test(args.expectedHash || '')) throw Error('请先读取文件获取hash；新建使用absent');
    let prior: Awaited<ReturnType<LocalCodeFiles['read']>> | undefined;
    try { prior = await this.read(path); } catch (e: any) { if (e.name !== 'NotFoundError') throw e; }
    if ((prior?.hash || 'absent') !== args.expectedHash) throw Error('文件已被外部修改或已存在，请重新读取，未覆盖文件');
    const replacement = typeof args.oldText === 'string' && typeof args.newText === 'string';
    if ((typeof args.content === 'string') === replacement || (!replacement && (args.oldText !== undefined || args.newText !== undefined))) throw Error('必须提供content或唯一oldText/newText，不能混用');
    let content: string;
    if (replacement) {
      const old = args.oldText, source = prior?.content || '', index = source.indexOf(old);
      if (!old || index < 0 || source.indexOf(old, index + 1) >= 0) throw Error('替换片段不存在或不唯一，请重新读取');
      content = source.slice(0, index) + args.newText + source.slice(index + old.length);
    } else content = args.content;
    localText(content);
    await beforeWrite(); await this.guard();
    // Re-read immediately before opening the stream. Browser APIs do not provide OS-wide CAS.
    let latest: any;
    try { latest = await this.read(path); } catch (e: any) { if (e.name !== 'NotFoundError') throw e; }
    if ((latest?.hash || 'absent') !== args.expectedHash) throw Error('保存前文件已变化，未覆盖文件');
    const handle = await this.handle(path, true);
    const relative = await this.root.resolve(handle);
    if (!relative || relative.join('/') !== path) throw Error('文件不在已授权目录');
    const stream = await handle.createWritable({ mode: 'exclusive' });
    try { await this.guard(); await stream.write(content); await this.guard(); await stream.close(); }
    catch (e) { try { await stream.abort(); } catch {} throw e; }
    return { path, saved: true, created: !prior, hash: await textHash(content), bytes: new TextEncoder().encode(content).length, note: '已写入本机；未执行代码' };
  }
}
