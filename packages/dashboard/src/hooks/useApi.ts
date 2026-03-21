const API_BASE = "/api/v1";

function getToken(): string {
  // 1. Injected by daemon into the HTML (most reliable)
  const injected = (window as any).__KORA_TOKEN__ as string | undefined;
  if (injected) return injected;

  // 2. From URL query param (e.g. ?token=abc)
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token");
  if (urlToken) {
    localStorage.setItem("kora_token", urlToken);
    return urlToken;
  }

  // 3. From localStorage (persisted from a previous visit)
  return localStorage.getItem("kora_token") || "";
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method || "GET";
  console.debug(`[api] ${method} ${path}`);
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    console.error(`[api] ${method} ${path} failed:`, res.status);
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  // Handle 204 No Content (e.g. DELETE responses)
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json();
}

export function useApi() {
  return {
    getSessions: () => apiFetch<{ sessions: any[] }>("/sessions"),
    createSession: (data: any) =>
      apiFetch("/sessions", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    getSession: (sid: string) => apiFetch(`/sessions/${sid}`),
    getAgents: (sid: string) =>
      apiFetch<{ agents: any[] }>(`/sessions/${sid}/agents`),
    spawnAgent: (sid: string, data: any) =>
      apiFetch(`/sessions/${sid}/agents`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    removeAgent: (sid: string, aid: string) =>
      apiFetch(`/sessions/${sid}/agents/${aid}`, { method: "DELETE" }),
    sendMessage: (sid: string, aid: string, msg: string) =>
      apiFetch(`/sessions/${sid}/agents/${aid}/message`, {
        method: "POST",
        body: JSON.stringify({ message: msg }),
      }),
    getOutput: (sid: string, aid: string, lines?: number) =>
      apiFetch<{ output: string[] }>(
        `/sessions/${sid}/agents/${aid}/output?lines=${lines || 100}`
      ),
    getProviders: () => apiFetch<{ providers: any[] }>("/providers"),
    getEvents: (sid: string, options?: {
      limit?: number;
      types?: string[];
      agentId?: string;
      search?: string;
      before?: string;
    }) => {
      const params = new URLSearchParams();
      params.set('limit', String(options?.limit || 50));
      if (options?.types && options.types.length > 0) {
        params.set('types', options.types.join(','));
      }
      if (options?.agentId) {
        params.set('agentId', options.agentId);
      }
      if (options?.search) {
        params.set('search', options.search);
      }
      if (options?.before) {
        params.set('before', options.before);
      }
      return apiFetch<{ events: any[] }>(`/sessions/${sid}/events?${params.toString()}`);
    },
    getEventsByTypes: (sid: string, types: string[], limit?: number) =>
      apiFetch<{ events: any[] }>(
        `/sessions/${sid}/events?types=${types.join(",")}&limit=${limit || 1000}`
      ),
    getStatus: () => apiFetch<any>("/status"),
    getTasks: (sid: string) =>
      apiFetch<{ tasks: any[] }>(`/sessions/${sid}/tasks`),
    createTask: (sid: string, data: any) =>
      apiFetch(`/sessions/${sid}/tasks`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    deleteTask: (sid: string, tid: string) =>
      apiFetch(`/sessions/${sid}/tasks/${tid}`, { method: "DELETE" }),
    updateTask: (sid: string, tid: string, data: any) =>
      apiFetch(`/sessions/${sid}/tasks/${tid}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    addTaskComment: (sid: string, tid: string, text: string) =>
      apiFetch(`/sessions/${sid}/tasks/${tid}/comments`, {
        method: "POST",
        body: JSON.stringify({ text, author: "user", authorName: "You" }),
      }),
    pauseSession: (sid: string) =>
      apiFetch(`/sessions/${sid}/pause`, { method: "POST" }),
    resumeSession: (sid: string) =>
      apiFetch(`/sessions/${sid}/resume`, { method: "POST" }),
    stopSession: (sid: string) =>
      apiFetch(`/sessions/${sid}`, { method: "DELETE" }),
    getPlaybooks: () => apiFetch<{ playbooks: string[] }>("/playbooks"),
    getPlaybook: (name: string) => apiFetch<any>(`/playbooks/${name}`),
    savePlaybook: (data: any) =>
      apiFetch("/playbooks", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    launchPlaybook: (sid: string, playbook: string, task?: string) =>
      apiFetch(`/sessions/${sid}/playbook`, {
        method: "POST",
        body: JSON.stringify({ playbook, task }),
      }),
    pauseResumeAgent: (sid: string, aid: string, action: "pause" | "resume") =>
      apiFetch(`/sessions/${sid}/agents/${aid}/${action}`, {
        method: "POST",
      }),
    changeModel: (sid: string, aid: string, model: string) =>
      apiFetch(`/sessions/${sid}/agents/${aid}/model`, {
        method: "PUT",
        body: JSON.stringify({ model }),
      }),
    replaceAgent: (sid: string, aid: string, opts?: { name?: string; model?: string; cliProvider?: string; persona?: string }) =>
      apiFetch<any>(`/sessions/${sid}/agents/${aid}/replace`, {
        method: "POST",
        body: JSON.stringify(opts ?? {}),
      }),
    restartAgent: (sid: string, aid: string, opts?: { carryContext?: boolean; contextLines?: number; summaryMode?: boolean }) =>
      apiFetch<any>(`/sessions/${sid}/agents/${aid}/restart`, {
        method: "POST",
        body: JSON.stringify(opts ?? {}),
      }),
    pollUsage: (sid: string) =>
      apiFetch<{ polled: boolean }>(`/sessions/${sid}/poll-usage`, { method: "POST" }),
    restartAllAgents: (sid: string, opts?: { carryContext?: boolean }) =>
      apiFetch<any>(`/sessions/${sid}/restart-all`, {
        method: "POST",
        body: JSON.stringify(opts ?? {}),
      }),
    broadcastMessage: (sid: string, message: string) =>
      apiFetch<any>(`/sessions/${sid}/broadcast`, { method: "POST", body: JSON.stringify({ message }) }),
    relayMessage: (sid: string, from: string, to: string, message: string) =>
      apiFetch<any>(`/sessions/${sid}/relay`, {
        method: "POST",
        body: JSON.stringify({ from, to, message }),
      }),
    addCustomModel: (sid: string, model: { id: string; label: string; provider: string }) =>
      apiFetch(`/sessions/${sid}/models`, { method: "POST", body: JSON.stringify(model) }),
    removeCustomModel: (sid: string, modelId: string, provider: string) =>
      apiFetch(`/sessions/${sid}/models/${encodeURIComponent(modelId)}?provider=${provider}`, { method: "DELETE" }),
    getSessionModels: (sid: string, provider: string) =>
      apiFetch<{ models: any[] }>(`/sessions/${sid}/models?provider=${provider}`),
    discoverModels: (providerId: string) =>
      apiFetch<{ discoveredModels: any[]; builtInModels: any[] }>(`/providers/${providerId}/discover`),
    openVscode: (sid: string, aid: string) =>
      apiFetch<{ opened: boolean; path: string }>(`/sessions/${sid}/agents/${aid}/open-vscode`, { method: "POST" }),
    openVscodeSession: (sid: string) =>
      apiFetch<{ opened: boolean; path: string }>(`/sessions/${sid}/open-vscode`, { method: "POST" }),
    openTerminal: (sid: string) =>
      apiFetch<{ id: string; tmuxSession: string; projectPath: string }>(`/sessions/${sid}/terminal`, { method: "POST" }),
    getTerminals: (sid: string) =>
      apiFetch<{ terminals: any[] }>(`/sessions/${sid}/terminals`),
    listFiles: (sid: string, subpath?: string) =>
      apiFetch<{ items: any[]; currentPath: string }>(`/sessions/${sid}/files?path=${encodeURIComponent(subpath || "")}`),
    readFile: (sid: string, filePath: string) =>
      apiFetch<{ content: string; path: string; language: string }>(`/sessions/${sid}/files/read?path=${encodeURIComponent(filePath)}`),
    writeFile: (sid: string, filePath: string, content: string) =>
      apiFetch<{ saved: boolean }>(`/sessions/${sid}/files/write`, { method: "PUT", body: JSON.stringify({ path: filePath, content }) }),
    getGitStatus: (sid: string) =>
      apiFetch<{ branch: string; changes: any[]; repos?: any[] }>(`/sessions/${sid}/git/status`),
    getGitDiff: (sid: string, filePath: string, repo?: string) =>
      apiFetch<{ diff: string; original: string; modified: string; path: string }>(`/sessions/${sid}/git/diff?path=${encodeURIComponent(filePath)}&repo=${encodeURIComponent(repo || ".")}`),
    nudgeAgent: (sid: string, aid: string) =>
      apiFetch<{ nudged: boolean; unreadCount: number }>(`/sessions/${sid}/agents/${aid}/nudge`, { method: "POST" }),
    getAgentOutput: (sid: string, aid: string, lines?: number) =>
      apiFetch<{ output: string[] }>(`/sessions/${sid}/agents/${aid}/output?lines=${lines || 100}`),
    deleteTerminal: (sid: string, tid: string) =>
      apiFetch<{ deleted: boolean; id: string }>(`/sessions/${sid}/terminals/${tid}`, { method: "DELETE" }),
    getRecentPaths: (limit?: number) =>
      apiFetch<{ paths: string[] }>(`/suggestions/paths?limit=${limit || 10}`),
    getRecentFlags: (limit?: number) =>
      apiFetch<{ flags: string[] }>(`/suggestions/flags?limit=${limit || 10}`),
    getRecentAgentConfigs: (limit?: number) =>
      apiFetch<{ configs: Array<{ provider: string; model: string; useCount: number }> }>(`/suggestions/agent-configs?limit=${limit || 10}`),
    // Personas CRUD
    getPersonas: () =>
      apiFetch<{ personas: Array<{ id: string; name: string; description: string; fullText: string; createdAt: string }> }>("/personas"),
    createPersona: (data: { name: string; description: string; fullText: string }) =>
      apiFetch<{ id: string; name: string; description: string; fullText: string }>("/personas", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    deletePersona: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/personas/${id}`, { method: "DELETE" }),
    // Stale task watchdog
    getNudgeHistory: (sid: string, tid: string) =>
      apiFetch<{ nudges: any[] }>(`/sessions/${sid}/tasks/${tid}/nudges`),
    getSessionNudges: (sid: string, limit?: number) =>
      apiFetch<{ nudges: any[] }>(`/sessions/${sid}/nudges?limit=${limit || 50}`),
    getNudgePolicies: (sid: string) =>
      apiFetch<{ policies: any }>(`/sessions/${sid}/nudge-policies`),
    updateNudgePolicies: (sid: string, policies: any) =>
      apiFetch<{ updated: boolean }>(`/sessions/${sid}/nudge-policies`, {
        method: "PUT",
        body: JSON.stringify({ policies }),
      }),
    nudgeTask: (sid: string, tid: string) =>
      apiFetch<{ success: boolean; nudgedAgent?: string }>(`/sessions/${sid}/tasks/${tid}/nudge`, {
        method: "POST",
      }),
    // Orchestrator blocking
    getBlockingState: (sid: string, aid: string) =>
      apiFetch<{ blocked: boolean; state: string; reason?: string; since?: string; bufferedMessages: number }>(`/sessions/${sid}/agents/${aid}/blocking`),
    resumeBlocked: (sid: string, aid: string, input?: string) =>
      apiFetch<{ success: boolean }>(`/sessions/${sid}/agents/${aid}/unblock`, {
        method: "POST",
        body: JSON.stringify({ input }),
      }),
    uploadPlaybook: (name: string, yaml: string) =>
      apiFetch<{ id: string; name: string }>("/playbooks", {
        method: "POST",
        body: JSON.stringify({ yaml }),
      }),
    broadcastRebase: (sid: string, prNumber?: number, prTitle?: string) =>
      apiFetch<{ broadcast: boolean; sentTo: number }>(`/sessions/${sid}/broadcast-rebase`, {
        method: "POST",
        body: JSON.stringify({ prNumber, prTitle }),
      }),
    getKnowledge: (sid: string) =>
      apiFetch<{ entries: Array<{ text: string; source: string; timestamp?: string }> }>(`/sessions/${sid}/knowledge`),
    clearKnowledge: (sid: string) =>
      apiFetch<{ cleared: boolean }>(`/sessions/${sid}/knowledge`, { method: "DELETE" }),
    approveRequest: (sid: string, aid: string, requestId: string) =>
      apiFetch<{ approved: boolean }>(`/sessions/${sid}/agents/${aid}/approve`, {
        method: "POST",
        body: JSON.stringify({ requestId }),
      }),
    rejectRequest: (sid: string, aid: string, requestId: string) =>
      apiFetch<{ rejected: boolean }>(`/sessions/${sid}/agents/${aid}/reject`, {
        method: "POST",
        body: JSON.stringify({ requestId }),
      }),
    // Task metrics / workload
    getTaskMetrics: (sid: string) =>
      apiFetch<{
        session: {
          totalTasks: number;
          activeTasks: number;
          doneTasks: number;
          blockedTasks: number;
          avgCycleTimeMs: number;
          throughput: number;
          topBottleneck: { agentId: string; agentName: string; score: number; reason: string } | null;
          loadDistribution: { overloaded: number; balanced: number; underutilized: number; idle: number };
        };
        agents: Array<{
          agentId: string;
          agentName: string;
          tasksByStatus: Record<string, number>;
          totalActiveTasks: number;
          doneTasks: number;
          blockedTasks: number;
          loadPercentage: number;
          capacity: number;
          isOverloaded: boolean;
          isIdle: boolean;
          bottleneckScore: number;
          avgCycleTimeMs: number;
          taskBlockingOthers: number;
          blockedAgents: string[];
          activity?: string;
        }>;
      }>(`/sessions/${sid}/task-metrics`),
  };
}
