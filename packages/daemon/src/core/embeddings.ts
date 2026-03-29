/**
 * Semantic embeddings module — generates 384-dim vectors using
 * all-MiniLM-L6-v2 via @xenova/transformers (ONNX, runs locally).
 *
 * Model is lazy-loaded on first use to avoid startup overhead.
 */

import { logger } from "./logger.js";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

let pipeline: any = null;
let loadingPromise: Promise<any> | null = null;

/**
 * Lazy-load the embedding pipeline. First call downloads/loads the model
 * (~23MB), subsequent calls reuse the cached instance.
 */
async function getEmbeddingPipeline(): Promise<any> {
  if (pipeline) return pipeline;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const { pipeline: createPipeline } = await import("@xenova/transformers");
      logger.info("[embeddings] Loading embedding model (first use)...");
      pipeline = await createPipeline("feature-extraction", MODEL_NAME, {
        quantized: true,
      });
      logger.info("[embeddings] Embedding model loaded successfully");
      return pipeline;
    } catch (err) {
      loadingPromise = null;
      logger.warn({ err }, "[embeddings] Failed to load embedding model — semantic search disabled");
      throw err;
    }
  })();

  return loadingPromise;
}

/**
 * Generate a 384-dimensional embedding vector for the given text.
 * Returns null if the model fails to load.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  try {
    const pipe = await getEmbeddingPipeline();
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return output.data as Float32Array;
  } catch {
    return null;
  }
}

/**
 * Cosine similarity between two vectors. Returns value in [-1, 1].
 * Both vectors must be the same length (384 for MiniLM).
 */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize a Buffer from SQLite BLOB back to Float32Array.
 */
export function deserializeEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Check if the embedding model is available (without loading it).
 */
export function isModelLoaded(): boolean {
  return pipeline !== null;
}

/** Embedding dimension (384 for all-MiniLM-L6-v2) */
export { EMBEDDING_DIM };
