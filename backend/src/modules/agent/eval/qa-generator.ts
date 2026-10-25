/**
 * Auto QA Pair Generator
 *
 * Uses LLM to generate question-answer pairs from EPUB chapters
 * for RAG retrieval evaluation.
 *
 * Output: JSON file with [{ question, answer, chapterTitle, chunkId }]
 *
 * Usage:
 *   const gen = new QAGenerator({ apiKey, apiBase, model });
 *   const qaPairs = await gen.generate(chapterTexts, { count: 80 });
 */

import * as fs from 'fs';

export interface QAPair {
  question: string;
  answer: string;
  chapterTitle: string;
  chunkId?: string;
  questionType: 'plot_detail' | 'character_relation' | 'scene_location' | 'text_match' | 'paragraph_summary';
}

export interface QAGenConfig {
  apiKey: string;
  apiBase: string;
  model: string;
}

export interface QAGenOptions {
  count?: number; // Number of QA pairs to generate (default 80)
  temperature?: number;
}

export class QAGenerator {
  private apiKey: string;
  private apiBase: string;
  private model: string;

  constructor(config: QAGenConfig) {
    this.apiKey = config.apiKey;
    this.apiBase = config.apiBase;
    this.model = config.model;
  }

  /**
   * Generate QA pairs from chapter texts
   */
  async generate(
    chapters: Array<{ title: string; content: string; index: number }>,
    options: QAGenOptions = {},
  ): Promise<QAPair[]> {
    const count = options.count || 80;
    const temp = options.temperature || 0.3;
    const allPairs: QAPair[] = [];

    // Distribute QA generation across chapters proportionally
    const totalChars = chapters.reduce((sum, ch) => sum + ch.content.length, 0);

    for (const chapter of chapters) {
      const proportion = chapter.content.length / totalChars;
      const chapterCount = Math.max(2, Math.round(count * proportion));

      const pairs = await this.generateForChapter(chapter, chapterCount, temp);
      allPairs.push(...pairs);

      // Progress log
      console.log(`  Generated ${pairs.length} QAs for "${chapter.title}"`);
    }

    return allPairs.slice(0, count);
  }

  /**
   * Generate QA pairs for a single chapter
   */
  private async generateForChapter(
    chapter: { title: string; content: string; index: number },
    count: number,
    temperature: number,
  ): Promise<QAPair[]> {
    // Truncate content if too long (to fit LLM context)
    const maxContentLen = 8000;
    const content = chapter.content.length > maxContentLen
      ? chapter.content.slice(0, maxContentLen / 2) + '\n...\n' + chapter.content.slice(-maxContentLen / 2)
      : chapter.content;

    const prompt = `你是一个小说内容理解专家。请仔细阅读以下小说章节内容，生成 ${count} 个中文问答题。

章节：${chapter.title}
内容：
${content}

要求：
1. 问题类型需多样化覆盖：
   - 情节细节题（如"XX事件发生在什么时候？""XX做了什么？"）
   - 人物关系题（如"XX和YY是什么关系？"）
   - 场景定位题（如"XX场景在什么地方？"）
   - 原文语句匹配题（如"原文中XX说了什么？"）
   - 段落主旨题（如"这一段主要讲了什么？"）
2. 答案必须严格从原文中提取完整文本片段，禁止编造
3. 答案片段长度 50-200 字

输出 JSON 数组格式：
[{"question": "问题", "answer": "原文答案片段", "type": "plot_detail|character_relation|scene_location|text_match|paragraph_summary"}]

只输出 JSON，不要解释。`;

    try {
      const response = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: 4000,
        }),
      });

      if (!response.ok) {
        console.error(`  LLM error for "${chapter.title}": ${response.status}`);
        return [];
      }

      const data = await response.json();
      const raw = data.choices?.[0]?.message?.content?.trim() || '';
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map((item: any) => ({
        question: item.question,
        answer: item.answer,
        chapterTitle: chapter.title,
        questionType: item.type || 'plot_detail',
      }));
    } catch (err: any) {
      console.error(`  Failed for "${chapter.title}": ${err.message}`);
      return [];
    }
  }

  /**
   * Associate QA pairs with chunk IDs after chunking
   */
  static associateChunks(qaPairs: QAPair[], chunks: Array<{ content: string; metadata: any }>): QAPair[] {
    return qaPairs.map(qa => {
      // Find the chunk that contains the answer text
      const matchingChunk = chunks.find(c => c.content.includes(qa.answer.slice(0, 50)));
      return {
        ...qa,
        chunkId: matchingChunk?.metadata?.chunkId,
      };
    });
  }

  /**
   * Save QA pairs to JSON file
   */
  static save(qaPairs: QAPair[], filePath: string): void {
    fs.writeFileSync(filePath, JSON.stringify(qaPairs, null, 2), 'utf-8');
    console.log(`Saved ${qaPairs.length} QA pairs to ${filePath}`);
  }

  /**
   * Load QA pairs from JSON file
   */
  static load(filePath: string): QAPair[] {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
}
