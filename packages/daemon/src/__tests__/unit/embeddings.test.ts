/**
 * Tests for embeddings module — cosine similarity + serialization.
 * Note: embed() requires @xenova/transformers model download, so
 * we test the pure math functions and serialization separately.
 */
import { describe, it, expect } from "vitest";
import { cosineSimilarity, serializeEmbedding, deserializeEmbedding, EMBEDDING_DIM } from "../../core/embeddings.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const vec = new Float32Array([1, 2, 3, 4, 5]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("handles normalized vectors correctly", () => {
    const a = new Float32Array([0.6, 0.8, 0]);
    const b = new Float32Array([0.8, 0.6, 0]);
    const similarity = cosineSimilarity(a, b);
    expect(similarity).toBeGreaterThan(0.9); // similar direction
    expect(similarity).toBeLessThan(1.0); // not identical
  });

  it("returns 0 for zero vectors", () => {
    const zero = new Float32Array([0, 0, 0]);
    const vec = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(zero, vec)).toBe(0);
  });

  it("works with regular number arrays", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });
});

describe("serializeEmbedding / deserializeEmbedding", () => {
  it("roundtrips correctly", () => {
    const original = new Float32Array([0.1, -0.5, 0.9, 0.0, 1.0]);
    const buf = serializeEmbedding(original);
    const restored = deserializeEmbedding(buf);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("handles 384-dim vector (MiniLM size)", () => {
    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i++) vec[i] = Math.random() * 2 - 1;

    const buf = serializeEmbedding(vec);
    expect(buf.byteLength).toBe(384 * 4); // 4 bytes per float32

    const restored = deserializeEmbedding(buf);
    expect(restored.length).toBe(384);
    for (let i = 0; i < 384; i++) {
      expect(restored[i]).toBeCloseTo(vec[i], 5);
    }
  });
});

describe("EMBEDDING_DIM", () => {
  it("is 384 (all-MiniLM-L6-v2)", () => {
    expect(EMBEDDING_DIM).toBe(384);
  });
});
