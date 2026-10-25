import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { QdrantPointPayload } from './rag.types';

@Injectable()
export class QdrantVectorService {
  private get base() { return (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, ''); }
  private path(name: string) { return '/collections/' + encodeURIComponent(name); }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.base + path, {
      ...init, signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json',
        ...(process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}) },
    });
    if (!response.ok) throw new ServiceUnavailableException('向量服务不可用 (' + response.status + ')');
    const body = await response.text();
    return (body.startsWith('{') ? JSON.parse(body) : body) as T;
  }

  async ensureCollection(name: string, size: number) {
    const existing = await this.request<{ result: { exists: boolean } }>(this.path(name) + '/exists');
    if (existing.result.exists) throw new Error('Refusing to overwrite an existing index collection');
    await this.request(this.path(name), { method: 'PUT', body: JSON.stringify({
      vectors: { size, distance: 'Cosine', on_disk: true }, on_disk_payload: true,
    }) });
    await this.request(this.path(name) + '/index?wait=true', {
      method: 'PUT', body: JSON.stringify({ field_name: 'documentId', field_schema: 'integer' }),
    });
  }

  async upsert(name: string, points: Array<{ id: string; vector: number[]; payload: QdrantPointPayload }>) {
    await this.request(this.path(name) + '/points?wait=true', {
      method: 'PUT', body: JSON.stringify({ points }),
    });
  }

  async search(name: string, vector: number[], documentIds: number[], limit = 20, chapters?: string[]) {
    if (!documentIds.length || chapters?.length === 0) return [];
    const response = await this.request<{ result: Array<{ id: string; score: number }> }>(
      this.path(name) + '/points/search', {
        method: 'POST', body: JSON.stringify({
          vector, limit, with_payload: false, with_vector: false,
          filter: { must: [{ key: 'documentId', match: { any: documentIds } },
            ...(chapters ? [{ key: 'chapter', match: { any: chapters } }] : [])] },
        }),
      });
    return response.result;
  }

  async count(name: string): Promise<number> {
    const response = await this.request<{ result: { count: number } }>(this.path(name) + '/points/count', {
      method: 'POST', body: JSON.stringify({ exact: true }),
    });
    return response.result.count;
  }

  async healthCheck() { await this.request('/healthz'); return true; }
}
