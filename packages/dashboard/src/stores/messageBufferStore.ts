import { create } from "zustand";

export interface BufferState {
  queueSize: number;
  expiredCount: number;
  lastUpdate: number;
}

interface MessageBufferStore {
  /** Per-agent buffer state */
  buffers: Map<string, BufferState>;
  /** Update buffer state for an agent (message-buffered event) */
  setBuffered: (agentId: string, queueSize: number) => void;
  /** Increment expired count for an agent (message-expired event) */
  addExpired: (agentId: string) => void;
  /** Remove an agent's buffer state (agent removed) */
  removeAgent: (agentId: string) => void;
  /** Clear all buffer state */
  clear: () => void;
}

export const useMessageBufferStore = create<MessageBufferStore>((set) => ({
  buffers: new Map(),

  setBuffered: (agentId, queueSize) =>
    set((state) => {
      const next = new Map(state.buffers);
      const prev = next.get(agentId) || { queueSize: 0, expiredCount: 0, lastUpdate: 0 };
      next.set(agentId, { ...prev, queueSize, lastUpdate: Date.now() });
      return { buffers: next };
    }),

  addExpired: (agentId) =>
    set((state) => {
      const next = new Map(state.buffers);
      const prev = next.get(agentId) || { queueSize: 0, expiredCount: 0, lastUpdate: 0 };
      next.set(agentId, { ...prev, expiredCount: prev.expiredCount + 1, lastUpdate: Date.now() });
      return { buffers: next };
    }),

  removeAgent: (agentId) =>
    set((state) => {
      const next = new Map(state.buffers);
      next.delete(agentId);
      return { buffers: next };
    }),

  clear: () => set({ buffers: new Map() }),
}));
