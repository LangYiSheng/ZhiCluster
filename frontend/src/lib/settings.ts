export type ConnectionConfig = {
  base_url: string;
  model: string;
  api_key_configured: boolean;
  timeout_seconds: number;
  max_retries: number;
};
export type RuntimeConfig = {
  revision: number;
  llm: ConnectionConfig & { supports_tools: boolean };
  embedding: ConnectionConfig & { dimension: number; batch_size: number };
  processing: {
    chunk_size_tokens: number;
    chunk_overlap_tokens: number;
    max_ingestion_attempts: number;
    max_concurrent_model_calls: number;
    summary_input_tokens: number;
    summary_max_calls: number;
  };
};
export type ConnectionDraft = Omit<ConnectionConfig, "api_key_configured"> & {
  api_key?: string;
  clear_api_key?: boolean;
};
export type RuntimeDraft = {
  llm: ConnectionDraft & { supports_tools: boolean };
  embedding: ConnectionDraft & { dimension: number; batch_size: number };
  processing: RuntimeConfig["processing"];
};
export type ProbeScope = "llm" | "embedding" | "tool_calling";
export type ModelScope = "llm" | "embedding";
export type ModelCatalog = {
  models: { id: string }[];
  message?: string;
};
export type ProbeResult = {
  ok: boolean;
  configured?: boolean;
  supported?: boolean;
  message: string;
  elapsed_ms?: number;
  dimension?: number;
};
export type ModelStatus = {
  llm?: { configured?: boolean; message?: string };
  embedding?: {
    configured?: boolean;
    needs_rebuild?: boolean;
    message?: string;
  };
  tool_calling?: { supported?: boolean; message?: string };
};
export function configDraft(config: RuntimeConfig): RuntimeDraft {
  const { api_key_configured: llmKey, ...llm } = config.llm;
  const { api_key_configured: embeddingKey, ...embedding } = config.embedding;
  void llmKey;
  void embeddingKey;
  return { llm, embedding, processing: { ...config.processing } };
}
export const rangeRules = {
  timeout_seconds: [1, 600],
  max_retries: [0, 4],
  dimension: [1, 16000],
  batch_size: [1, 256],
  chunk_size_tokens: [128, 8192],
  chunk_overlap_tokens: [0, 2048],
  max_ingestion_attempts: [1, 10],
  max_concurrent_model_calls: [1, 16],
  summary_input_tokens: [1024, 200000],
  summary_max_calls: [1, 100],
} as const;
