import { create } from "zustand";

export interface TerminalSession {
  id: string;
  tmuxSession?: string;
  name: string;
  type: "agent" | "standalone";
  agentName?: string;
  createdAt: string;
}

interface TerminalSessionStore {
  sessions: Map<string, TerminalSession>;
  /** Tracks which terminal tabs are open in the side panel */
  openTabs: string[];
  addSession: (session: TerminalSession) => void;
  removeSession: (id: string) => void;
  getSessions: () => TerminalSession[];
  getByType: (type: "agent" | "standalone") => TerminalSession[];
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  setOpenTabs: (tabs: string[]) => void;
  /** Remove sessions not in the given set of valid IDs */
  pruneStale: (validIds: Set<string>) => void;
  clear: () => void;
}

export const useTerminalSessionStore = create<TerminalSessionStore>((set, get) => ({
  sessions: new Map(),
  openTabs: [],

  addSession: (session) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(session.id, session);
      return { sessions: next };
    }),

  removeSession: (id) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.delete(id);
      return {
        sessions: next,
        openTabs: state.openTabs.filter((t) => t !== id),
      };
    }),

  getSessions: () => Array.from(get().sessions.values()),

  getByType: (type) =>
    Array.from(get().sessions.values()).filter((s) => s.type === type),

  openTab: (id) =>
    set((state) => ({
      openTabs: state.openTabs.includes(id)
        ? state.openTabs
        : [...state.openTabs, id],
    })),

  closeTab: (id) =>
    set((state) => ({
      openTabs: state.openTabs.filter((t) => t !== id),
    })),

  setOpenTabs: (tabs) => set({ openTabs: tabs }),

  pruneStale: (validIds) =>
    set((state) => {
      const next = new Map<string, TerminalSession>();
      for (const [id, session] of state.sessions) {
        if (validIds.has(id)) next.set(id, session);
      }
      if (next.size === state.sessions.size) return state;
      return {
        sessions: next,
        openTabs: state.openTabs.filter((t) => validIds.has(t)),
      };
    }),

  clear: () => set({ sessions: new Map(), openTabs: [] }),
}));
