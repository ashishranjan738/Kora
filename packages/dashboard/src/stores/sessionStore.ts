import { create } from "zustand";

interface SessionStore {
  sessions: any[];
  loading: boolean;
  error: string | null;
  fetchSessions: () => Promise<void>;
  addSession: (session: any) => void;
  removeSession: (id: string) => void;
  updateSession: (id: string, updates: any) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,

  fetchSessions: async () => {
    set({ loading: true, error: null });
    try {
      const token = (window as any).__KORA_TOKEN__ ||
        localStorage.getItem("kora_token") || "";
      const res = await fetch("/api/v1/sessions", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
      const data = await res.json();
      set({ sessions: data.sessions || [], loading: false });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  addSession: (session) => {
    set({ sessions: [...get().sessions, session] });
  },

  removeSession: (id) => {
    set({ sessions: get().sessions.filter((s) => s.id !== id) });
  },

  updateSession: (id, updates) => {
    set({
      sessions: get().sessions.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    });
  },
}));
