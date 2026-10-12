export type MemoryKind = "preference" | "question" | "source" | "interaction";
export interface PreferenceMemory {
  id: string;
  content: string;
  sourceQuestionId: string | null;
  sourceQuestion: string | null;
  createdAt: string;
  updatedAt: string;
  status: "active";
}
export interface MemorySearchHit {
  id: string;
  kind: MemoryKind;
  title: string;
  excerpt: string;
  createdAt: string;
  updatedAt: string;
  rank: number;
  workflowId: string | null;
  sourceId: string | null;
  tableId: string | null;
  originalRow: number | null;
  citation: string | null;
}
export interface MemorySearchOptions {
  query: string;
  kinds?: MemoryKind[];
  since?: string;
  until?: string;
  limit?: number;
  /** Trusted manual search API only. Agent recall must respect the user's enabled setting. */
  explicit?: boolean;
}
export interface MemorySearchResult {
  enabled: boolean;
  results: MemorySearchHit[];
  hasMore: boolean;
  coverage: { totalSources: number; indexedSources: number; pendingSources: number; failedSources: number };
}
export const MEMORY_LIMITS = {
  preferenceChars: 2000,
  preferences: 100,
  queryChars: 500,
  results: 30,
  chunkChars: 8000,
  indexChars: 32 * 1024 * 1024,
  indexChunks: 60_000,
} as const;
export class MemoryError extends Error {
  constructor(message: string, readonly code: "invalid" | "not_found" | "disabled" | "unavailable" = "invalid") { super(message); this.name = "MemoryError"; }
}
