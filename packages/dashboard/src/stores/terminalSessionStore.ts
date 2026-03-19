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
  addSession: (session: TerminalSession) => void;
  removeSession: (id: string) => void;
  getSessions: () => TerminalSession[];
  getByType: (type: "agent" | "standalone") => TerminalSession[];
  clear: () => void;
}

export const useTerminalSessionStore = create<TerminalSessionStore>((set, get) => ({
  sessions: new Map(),

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
      return { sessions: next };
    }),

  getSessions: () => Array.from(get().sessions.values()),

  getByType: (type) =>
    Array.from(get().sessions.values()).filter((s) => s.type === type),

  clear: () => set({ sessions: new Map() }),
}));
