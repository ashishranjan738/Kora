interface SessionStore {
    sessions: any[];
    loading: boolean;
    error: string | null;
    fetchSessions: () => Promise<void>;
    addSession: (session: any) => void;
    removeSession: (id: string) => void;
    updateSession: (id: string, updates: any) => void;
}
export declare const useSessionStore: import("zustand").UseBoundStore<import("zustand").StoreApi<SessionStore>>;
export {};
//# sourceMappingURL=sessionStore.d.ts.map