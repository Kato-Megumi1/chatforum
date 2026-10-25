export interface RagPrincipal {
  userId: number;
  role?: string;
}

export interface RagCitation {
  chunkId: string;
  documentId: number;
  documentVersion: number;
  fileName: string;
  indexVersion: number;
  chunkIndex: number;
  page?: number;
  chapter?: string;
  url: string;
}

export interface RagPassage {
  content: string;
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
  rerankScore?: number;
  graphScore?: number;
  citation: RagCitation;
  acl: {
    visibility: string;
    ownerId?: number;
  };
}

export interface RagSearchDecision {
  passages: RagPassage[];
  confidence: number;
  needsExpertReview: boolean;
  indexVersion: number;
  reviewTaskId?: number;
  degraded?: boolean;
  retrieval?: {
    status: 'complete' | 'no_active_index' | 'no_accessible_documents' | 'scope_no_match';
    channels?: Record<'semantic' | 'lexical' | 'graph', 'ok' | 'skipped' | 'error'>;
    counts?: Record<'semantic' | 'lexical' | 'graph', number>;
  };
  graph?: { version: string; cached?: boolean; failed?: boolean; facts?: number; contextChunks?: number };
}

export interface QdrantPointPayload {
  knowledgeBaseId: number;
  indexVersion: number;
  documentId: number;
  documentVersion: number;
  chunkIndex: number;
  fileName: string;
  page?: number;
  chapter?: string;
  content: string;
  visibility: string;
  ownerId?: number;
}
