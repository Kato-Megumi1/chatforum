import { EpubChunker } from './epub-chunker';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const AdmZip = require('adm-zip');
test('spine order, first actual chapter, paratext exclusion and exact contiguous offsets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatforum-epub-'));
  const file = path.join(dir, 'fixture.epub');
  try {
    const zip = new AdmZip();
    const add = (name: string, text: string) => zip.addFile(name, Buffer.from(text));
    add('META-INF/container.xml', '<container><rootfile full-path="book.opf" /></container>');
    add('book.opf', '<package><manifest><item id="b" href="b.html"/><item id="a" href="a.html"/><item id="z" href="z.html"/></manifest><spine><itemref idref="b"/><itemref idref="a"/><itemref idref="z"/></spine></package>');
    add('b.html', '<head><title>第一卷 第一章</title></head><p>' + '「先商量好吗？」😀这是一个完整段落。'.repeat(30) + '</p><p>短尾巴不能丢。</p>');
    add('a.html', '<head><title>第一卷 第二章</title></head><p>小说的第二章有正文。</p>');
    add('z.html', '<head><title>第一卷 后记</title></head><p>作者的致谢不是角色记忆。</p>');
    zip.writeZip(file);
    for (const overlap of [0, 25]) {
      const chunker = new EpubChunker({ chunkSize: 100, overlap });
      const chapters = chunker.extractChapters(file), chunks = await chunker.chunk(file);
      expect(chapters.map(c => c.entryName)).toEqual(['b.html', 'a.html']);
      expect(chunks.at(-1).content).toContain('小说的第二章');
      for (const chapter of chapters) {
        const coverage = new Uint8Array(chapter.content.length);
        for (const c of chunks.filter(c => c.metadata.chapterIndex === chapter.index)) {
          expect(c.content.length).toBeLessThanOrEqual(100);
          expect(chapter.content.slice(c.metadata.offsetInChapter, c.metadata.endOffsetInChapter)).toBe(c.content);
          coverage.fill(1, c.metadata.offsetInChapter, c.metadata.endOffsetInChapter);
          expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c.content)).toBe(false);
        }
        expect([...chapter.content].length).toBeGreaterThan(0);
        for (let i = 0; i < chapter.content.length; i++) if (!/\s/.test(chapter.content[i])) expect(coverage[i]).toBe(1);
      }
    }
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('invalid overlap cannot stall ingestion', () => {
  expect(() => new EpubChunker({ chunkSize: 100, overlap: 100 })).toThrow();
});
