/**
 * Tests for RingBuffer — terminal output line buffer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RingBuffer } from "../../core/ring-buffer.js";

describe("RingBuffer", () => {
  let buf: RingBuffer;

  beforeEach(() => {
    buf = new RingBuffer(5); // small capacity for easy testing
  });

  describe("write + getLastLines", () => {
    it("stores complete lines", () => {
      buf.write("line1\nline2\nline3\n");
      expect(buf.getLastLines()).toEqual(["line1", "line2", "line3"]);
    });

    it("handles partial lines across writes", () => {
      buf.write("hel");
      buf.write("lo\nworld\n");
      expect(buf.getLastLines()).toEqual(["hello", "world"]);
    });

    it("accumulates partial line until newline", () => {
      buf.write("partial");
      expect(buf.size).toBe(0);
      expect(buf.getPartial()).toBe("partial");
      buf.write(" complete\n");
      expect(buf.size).toBe(1);
      expect(buf.getLastLine()).toBe("partial complete");
    });

    it("handles \\r\\n line endings", () => {
      buf.write("line1\r\nline2\r\n");
      expect(buf.getLastLines()).toEqual(["line1", "line2"]);
    });

    it("wraps around when capacity exceeded", () => {
      buf.write("a\nb\nc\nd\ne\nf\ng\n");
      // Capacity 5, so only last 5 lines kept
      expect(buf.size).toBe(5);
      expect(buf.getLastLines()).toEqual(["c", "d", "e", "f", "g"]);
    });

    it("getLastLines(n) returns requested count", () => {
      buf.write("a\nb\nc\n");
      expect(buf.getLastLines(2)).toEqual(["b", "c"]);
    });

    it("getLastLines(n) clamps to available lines", () => {
      buf.write("a\nb\n");
      expect(buf.getLastLines(10)).toEqual(["a", "b"]);
    });

    it("getLastLines(0) returns empty", () => {
      buf.write("a\n");
      expect(buf.getLastLines(0)).toEqual([]);
    });
  });

  describe("getLastLine", () => {
    it("returns empty string when empty", () => {
      expect(buf.getLastLine()).toBe("");
    });

    it("returns most recent complete line", () => {
      buf.write("old\nnew\n");
      expect(buf.getLastLine()).toBe("new");
    });
  });

  describe("getAll", () => {
    it("returns all stored lines", () => {
      buf.write("a\nb\nc\n");
      expect(buf.getAll()).toEqual(["a", "b", "c"]);
    });
  });

  describe("clear", () => {
    it("resets buffer state", () => {
      buf.write("a\nb\npartial");
      buf.clear();
      expect(buf.size).toBe(0);
      expect(buf.getPartial()).toBe("");
      expect(buf.getLastLines()).toEqual([]);
    });
  });

  describe("stripAnsi", () => {
    it("removes CSI color codes", () => {
      expect(RingBuffer.stripAnsi("\x1b[1;32mgreen\x1b[0m")).toBe("green");
    });

    it("removes OSC sequences", () => {
      expect(RingBuffer.stripAnsi("\x1b]0;title\x07text")).toBe("text");
    });

    it("leaves plain text unchanged", () => {
      expect(RingBuffer.stripAnsi("plain text")).toBe("plain text");
    });
  });

  describe("getLastLinesClean", () => {
    it("returns lines with ANSI stripped", () => {
      buf.write("\x1b[31mred\x1b[0m\n\x1b[32mgreen\x1b[0m\n");
      expect(buf.getLastLinesClean()).toEqual(["red", "green"]);
    });
  });

  describe("large capacity", () => {
    it("handles default 1000-line capacity", () => {
      const large = new RingBuffer(1000);
      for (let i = 0; i < 1500; i++) {
        large.write(`line-${i}\n`);
      }
      expect(large.size).toBe(1000);
      const lines = large.getLastLines(3);
      expect(lines).toEqual(["line-1497", "line-1498", "line-1499"]);
    });
  });
});
