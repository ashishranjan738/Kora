/**
 * Integration tests for semantic embeddings.
 * Tests cosine similarity, serialization, and lazy-load behavior.
 */

import { describe, it, expect } from "vitest";

describe("Semantic embeddings", () => {
  it("cosineSimilarity returns 1.0 for identical vectors", async () => {
    const { cosineSimilarity } = await import("../../core/embeddings.js");
    const vec = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it("cosineSimilarity returns 0 for orthogonal vectors", async () => {
    const { cosineSimilarity } = await import("../../core/embeddings.js");
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("serialize/deserialize round-trip preserves embedding", async () => {
    const { serializeEmbedding, deserializeEmbedding } = await import("../../core/embeddings.js");
    const original = new Float32Array([0.1, 0.2, 0.3, -0.5, 0.99]);
    const serialized = serializeEmbedding(original);
    const restored = deserializeEmbedding(serialized);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("isModelLoaded returns false before first embed() call", async () => {
    const { isModelLoaded } = await import("../../core/embeddings.js");
    expect(isModelLoaded()).toBe(false);
  });
});
