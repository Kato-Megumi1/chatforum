/**
 * EPUB Structured Semantic Chunker
 *
 * Novel-specific chunking strategy:
 * - Level 1: Chapter boundaries (never cross chapters)
 * - Level 2: Semantic boundaries within chapters (paragraphs, dialogue, scenes)
 * - Metadata: book name, volume, chapter title, position offset, chunk ID
 *
 * Usage:
 *   const chunker = new EpubChunker({ chunkSize: 500, overlap: 50 });
 *   const result = await chunker.chunk('path/to/novel.epub');
 */

import * as fs from 'fs';
import * as path from 'path';
import { Document } from '@langchain/core/documents';

const AdmZip = require('adm-zip');

export interface ChunkConfig {
  /** Target characters per chunk (default 500) */
  chunkSize?: number;
  /** Overlap characters between adjacent chunks (default 50) */
  overlap?: number;
  /** Minimum characters for a valid chunk (default 100) */
  minChunkSize?: number;
}

export interface ChunkMetadata {
  chunkId: string;
  bookName: string;
  volumeTitle: string;
  chapterTitle: string;
  chapterIndex: number;
  offsetInChapter: number;
  endOffsetInChapter: number;
  entryName: string;
  sectionType: string;
  isFirstChunk: boolean;
  isLastChunk: boolean;
}

export interface StructuredChunk {
  content: string;
  metadata: ChunkMetadata;
}

export interface ChapterInfo {
  title: string;
  content: string;
  index: number;
  entryName?: string;
  volumeTitle?: string;
  sectionType?: string;
}

export class EpubChunker {
  private config: Required<ChunkConfig>;

  constructor(config: ChunkConfig = {}) {
    this.config = {
      chunkSize: config.chunkSize ?? 500,
      overlap: config.overlap ?? 50,
      minChunkSize: config.minChunkSize ?? 50,
    };
    if (this.config.chunkSize < 100 || this.config.overlap < 0 || this.config.overlap >= this.config.chunkSize)
      throw new Error('Invalid chunk size/overlap');
  }

  /**
   * Main entry point: chunk an EPUB file into structured chunks
   */
  async chunk(epubPath: string): Promise<StructuredChunk[]> {
    const bookName = path.basename(epubPath, '.epub');
    const chapters = this.extractChapters(epubPath);
    const allChunks: StructuredChunk[] = [];

    for (const chapter of chapters) {
      const chapterChunks = this.chunkChapter(chapter, bookName);
      allChunks.push(...chapterChunks);
    }

    return allChunks;
  }

  /**
   * Extract chapters from EPUB using TOC and HTML content
   */
  extractChapters(epubPath: string): ChapterInfo[] {
    const zip = new AdmZip(epubPath);
    const entries = zip.getEntries();
    if (entries.length > 10000 || entries.some((e: any) => e.header.size > 20 * 1024 * 1024) ||
      entries.reduce((n: number, e: any) => n + e.header.size, 0) > 200 * 1024 * 1024)
      throw new Error('EPUB 解压大小超限');
    const chapters: ChapterInfo[] = [];

    // Filter HTML/XHTML content files (exclude only clearly non-content pages)
    const htmlEntries = entries.filter(
      (e: any) =>
        !e.isDirectory &&
        /\.(x?html|htm)$/i.test(e.entryName) &&
        !/toc\.(x?html|htm)|nav\.(x?html|htm)|cover\.(x?html|htm)|copyright\.(x?html|htm)|colophon\.(x?html|htm)/i.test(e.entryName),
    );

    // Reading order is the OPF spine, never the alphabetical ZIP entry order.
    const attr = (tag: string, name: string) => tag.match(new RegExp('\\b' + name + '\\s*=\\s*["\\x27]([^"\\x27]+)["\\x27]', 'i'))?.[1];
    const container = zip.getEntry('META-INF/container.xml')?.getData().toString('utf8') || '';
    const rootTag = container.match(/<rootfile\b[^>]*>/i)?.[0] || '';
    const opfPath = attr(rootTag, 'full-path');
    const opf = opfPath ? zip.getEntry(opfPath)?.getData().toString('utf8') : null;
    if (!opf) throw new Error('EPUB 缺少可验证的阅读顺序（OPF spine）');
    const manifest = new Map<string, string>();
    for (const item of opf.match(/<item\b[^>]*>/gi) || []) {
      const id = attr(item, 'id'), href = attr(item, 'href');
      if (id && href && !/^[a-z]+:/i.test(href)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath!), decodeURIComponent(href.split('#')[0])));
        if (!resolved.startsWith('../')) manifest.set(id, resolved.replace(/&amp;/g, '&'));
      }
    }
    const spine = (opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)?.[1] || '').match(/<itemref\b[^>]*>/gi) || [];
    const order = spine.filter((tag: string) => attr(tag, 'linear') !== 'no')
      .map((tag: string) => manifest.get(attr(tag, 'idref') || '')).filter(Boolean);
    if (!order.length) throw new Error('EPUB 阅读顺序为空');
    const ordered = order.map((name: string) => htmlEntries.find((e: any) => e.entryName === name)).filter(Boolean);
    htmlEntries.splice(0, htmlEntries.length, ...ordered);

    for (let i = 0; i < htmlEntries.length; i++) {
      const entry = htmlEntries[i];
      try {
        const rawHtml = entry.getData().toString('utf-8');
        const title = this.extractChapterTitle(rawHtml, entry.entryName, i);
        const text = this.htmlToCleanText(rawHtml);
        const sectionType = /后记|版权|插图|目录|译者|制作信息/.test(title) ? 'paratext' : /特典|番外|Girls?\s*Side|Memorial/i.test(title) ? 'side_story' : 'main_story';

        const titleOnly = text.replace(/\s/g, '') === title.replace(/\s/g, '');
        const titlePage = text.length < 160 && text.startsWith(title) &&
          /^\s*(?:作者|著者|原作)\s*[：:]/.test(text.slice(title.length));
        if (text.trim().length > 0 && sectionType !== 'paratext' && !titleOnly && !titlePage) {
          chapters.push({ title, content: text, index: i, entryName: entry.entryName, sectionType,
            volumeTitle: title.match(/^第[一二三四五六七八九十百零〇\d]+卷/)?.[0] || title.split(/\s/)[0] });
        }
      } catch {
        // Skip unreadable entries
      }
    }

    return chapters;
  }

  /**
   * Extract chapter title from HTML or derive from filename
   */
  private extractChapterTitle(html: string, entryName: string, index: number): string {
    // Try to find <title> tag content
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const t = titleMatch[1].trim();
      // Clean common patterns
      return t.replace(/^\d+[\.\s]+/, '').replace(/\s*[-–—|]\s*.+$/, '').slice(0, 100);
    }
    // Try h1-h3
    for (const tag of ['h1', 'h2', 'h3']) {
      const hMatch = html.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
      if (hMatch) return hMatch[1].trim().slice(0, 100);
    }
    // Fallback: filename
    const name = path.basename(entryName, path.extname(entryName));
    return name || `Chapter ${index + 1}`;
  }

  /**
   * Convert HTML to clean plain text for novels
   */
  private htmlToCleanText(html: string): string {
    return html
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      // Remove scripts and styles
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // Remove comments
      .replace(/<!--[\s\S]*?-->/g, '')
      // Remove navigation elements
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      // Convert block elements to newlines
      .replace(/<\/(?:div|p|h[1-6]|li|tr|br|section|article)[^>]*>/gi, '\n')
      .replace(/<(?:br|hr)[^>]*\/?>/gi, '\n')
      // Remove all remaining HTML tags
      .replace(/<[^>]*>/g, '')
      // Decode HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      // Remove image alt text placeholders
      .replace(/\[插图[^\]]*\]/g, '')
      .replace(/【[插图图注]*[】]/g, '')
      // Normalize whitespace
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      // Remove leading/trailing whitespace per line
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n')
      .trim();
  }

  /**
   * Chunk a single chapter into semantic fragments
   * Level 1: Never cross chapter boundaries (enforced by design)
   * Level 2: Split on semantic units (paragraphs, dialogue breaks, scene transitions)
   */
  private chunkChapter(chapter: ChapterInfo, bookName: string): StructuredChunk[] {
    const text = chapter.content, { chunkSize, overlap } = this.config;
    const result: StructuredChunk[] = [];
    let start = 0;
    while (start < text.length) {
      while (start < text.length && /\s/.test(text[start])) start++;
      if (start === text.length) break;
      let end = Math.min(text.length, start + chunkSize);
      // Prefer a complete paragraph / sentence near the target size, never
      // concatenate/rewrite passages: source offsets must reconstruct every chunk.
      if (end < text.length) {
        const floor = start + Math.floor(chunkSize * .6);
        let boundary = -1;
        for (let i = end - 1; i >= floor; i--) {
          if (text[i] === '\n') { boundary = i; break; }
        }
        if (boundary < 0) for (let i = end - 1; i >= floor; i--) {
          if (/[。！？!?」』]/.test(text[i])) { boundary = i + 1; break; }
        }
        if (boundary > start) end = boundary;
        if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      }
      while (end > start && /\s/.test(text[end - 1])) end--;
      result.push(this.makeChunk(text.slice(start, end), chapter, bookName, result.length, start, !result.length, end === text.length));
      if (end === text.length) break;
      let following = end;
      if (overlap > 0) {
        following = Math.max(start + 1, end - overlap);
        // Align overlap to a paragraph boundary when there is one in the overlap window.
        const newline = text.indexOf('\n', following);
        if (newline >= following && newline < end - 15) following = newline + 1;
        if (/[\uDC00-\uDFFF]/.test(text[following])) following++;
      }
      start = following;
    }
    if (result.length) result[result.length - 1].metadata.isLastChunk = true;
    return result;
  }

  /**
   * Create a structured chunk with full metadata
   */
  private makeChunk(
    content: string,
    chapter: ChapterInfo,
    bookName: string,
    chunkIdx: number,
    offset: number,
    isFirst: boolean,
    isLast: boolean,
  ): StructuredChunk {
    const chunkId = `${bookName}_ch${chapter.index + 1}_${chunkIdx}`;
    return {
      content: content.trim(),
      metadata: {
        chunkId,
        bookName,
        volumeTitle: chapter.volumeTitle || '',
        chapterTitle: chapter.title,
        chapterIndex: chapter.index,
        offsetInChapter: offset,
        endOffsetInChapter: offset + content.trim().length,
        entryName: chapter.entryName || '',
        sectionType: chapter.sectionType || 'main_story',
        isFirstChunk: isFirst,
        isLastChunk: isLast,
      },
    };
  }

  /**
   * Convert to LangChain Documents for compatibility
   */
  toLangChainDocuments(chunks: StructuredChunk[]): Document[] {
    return chunks.map(
      c =>
        new Document({
          pageContent: c.content,
          metadata: c.metadata as Record<string, any>,
        }),
    );
  }
}
