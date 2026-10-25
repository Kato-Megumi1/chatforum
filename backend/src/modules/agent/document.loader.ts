import { Document } from '@langchain/core/documents';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Multi-format document loader.
 * Supports TXT, PDF, and EPUB files.
 */
export class MultiFormatDocumentLoader {
  /**
   * Load a document file and return LangChain Document objects.
   */
  static async load(filePath: string, fileType: string): Promise<Document[]> {
    const ext = fileType.toLowerCase();

    switch (ext) {
      case 'txt':
        return this.loadTxt(filePath);
      case 'pdf':
        return this.loadPdf(filePath);
      case 'epub':
        return this.loadEpub(filePath);
      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }
  }

  private static async loadTxt(filePath: string): Promise<Document[]> {
    const loader = new TextLoader(filePath);
    return loader.load();
  }

  private static async loadPdf(filePath: string): Promise<Document[]> {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const documents: Document[] = [];
    await pdfParse(dataBuffer, { pagerender: async (page: any) => {
      const data = await page.getTextContent();
      const text = data.items.map((item: any) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
      documents.push(new Document({ pageContent: text,
        metadata: { source: path.basename(filePath), fileType: 'pdf', page: page.pageNumber } }));
      return text;
    } });
    return documents.sort((a, b) => a.metadata.page - b.metadata.page);
  }

  private static async loadEpub(filePath: string): Promise<Document[]> {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    const documents: Document[] = [];
    const fileName = path.basename(filePath);

    // EPUB is a ZIP containing XHTML/HTML files in OEBPS or similar directories
    const htmlEntries = zipEntries.filter(
      (entry: any) =>
        !entry.isDirectory &&
        (entry.entryName.endsWith('.html') ||
          entry.entryName.endsWith('.xhtml') ||
          entry.entryName.endsWith('.htm')),
    );

    // Sort by entry name to maintain chapter order
    htmlEntries.sort((a: any, b: any) => a.entryName.localeCompare(b.entryName));

    for (let i = 0; i < htmlEntries.length; i++) {
      const entry = htmlEntries[i];
      try {
        const rawContent = entry.getData().toString('utf-8');
        const text = this.stripHtml(rawContent);
        if (text.trim().length > 50) {
          // Extract a title from the file name
          const entryTitle = path.basename(entry.entryName).replace(/\.(x?html|htm)$/i, '');
          documents.push(
            new Document({
              pageContent: text,
              metadata: {
                source: fileName,
                fileType: 'epub',
                chapterIndex: i,
                chapterTitle: entryTitle,
                entryName: entry.entryName,
              },
            }),
          );
        }
      } catch {
        // Skip entries that can't be read
      }
    }

    // If no HTML files found, try to extract any text from all entries
    if (documents.length === 0) {
      let allText = '';
      for (const entry of zipEntries) {
        if (!entry.isDirectory) {
          try {
            const content = entry.getData().toString('utf-8');
            const text = this.stripHtml(content);
            if (text.trim()) {
              allText += text + '\n\n';
            }
          } catch {}
        }
      }
      if (allText.trim()) {
        documents.push(
          new Document({
            pageContent: allText,
            metadata: { source: fileName, fileType: 'epub' },
          }),
        );
      }
    }

    return documents;
  }

  private static stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_: string, code: string) => String.fromCharCode(parseInt(code, 10)))
      .replace(/\s+/g, ' ')
      .trim();
  }
}
