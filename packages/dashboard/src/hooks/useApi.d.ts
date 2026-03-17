export declare function useApi(): {
    getSessions: () => Promise<{
        sessions: any[];
    }>;
    createSession: (data: any) => Promise<unknown>;
    getSession: (sid: string) => Promise<unknown>;
    getAgents: (sid: string) => Promise<{
        agents: any[];
    }>;
    spawnAgent: (sid: string, data: any) => Promise<unknown>;
    removeAgent: (sid: string, aid: string) => Promise<unknown>;
    sendMessage: (sid: string, aid: string, msg: string) => Promise<unknown>;
    getOutput: (sid: string, aid: string, lines?: number) => Promise<{
        output: string[];
    }>;
    getProviders: () => Promise<{
        providers: any[];
    }>;
    getEvents: (sid: string, limit?: number) => Promise<{
        events: any[];
    }>;
    getStatus: () => Promise<any>;
    getTasks: (sid: string) => Promise<{
        tasks: any[];
    }>;
    createTask: (sid: string, data: any) => Promise<unknown>;
    updateTask: (sid: string, tid: string, data: any) => Promise<unknown>;
    getPlaybooks: () => Promise<{
        playbooks: string[];
    }>;
    getPlaybook: (name: string) => Promise<any>;
    savePlaybook: (data: any) => Promise<unknown>;
};
//# sourceMappingURL=useApi.d.ts.map