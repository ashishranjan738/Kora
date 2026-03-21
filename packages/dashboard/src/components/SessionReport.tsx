import { useState, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { extractCostData } from "./CostSummary";
import {
  Modal,
  Button,
  Stack,
  Group,
  Text,
  Paper,
  Badge,
  Loader,
  ScrollArea,
  Divider,
  Tooltip,
} from "@mantine/core";
import { MarkdownText } from "./MarkdownText";

// ── Types ────────────────────────────────────────────────────

interface SessionReportProps {
  sessionId: string;
  sessionName: string;
  agents: any[];
  opened: boolean;
  onClose: () => void;
}

interface ReportData {
  session: {
    name: string;
    id: string;
    status: string;
    projectPath?: string;
    createdAt?: string;
  };
  agents: {
    name: string;
    id: string;
    role: string;
    status: string;
    provider: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    startedAt?: string;
  }[];
  tasks: {
    total: number;
    done: number;
    inProgress: number;
    review: number;
    pending: number;
    items: { title: string; status: string; assignedTo?: string; priority: string }[];
  };
  events: {
    total: number;
    byType: Record<string, number>;
    recent: { type: string; timestamp: string; summary: string }[];
  };
  cost: {
    total: number;
    byAgent: { name: string; cost: number; tokensIn: number; tokensOut: number }[];
  };
  generatedAt: string;
}

// ── Helpers ──────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtDate(iso?: string): string {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleString();
}

function summarizeEvent(event: any): string {
  const d = event.data || {};
  switch (event.type) {
    case "agent-spawned":
      return `Agent "${d.agentName || d.name || "?"}" spawned`;
    case "agent-removed":
      return `Agent "${d.agentName || d.name || "?"}" removed`;
    case "agent-crashed":
      return `Agent "${d.agentName || d.name || "?"}" crashed`;
    case "agent-restarted":
      return `Agent "${d.agentName || d.name || "?"}" restarted`;
    case "message-sent":
      return `Message from ${d.from || "?"} to ${d.to || "?"}`;
    case "broadcast":
      return `Broadcast from ${d.from || "?"}`;
    case "task-created":
      return `Task created: "${d.title || "?"}"`;
    case "task-completed":
      return `Task completed: "${d.title || "?"}"`;
    case "task-updated":
      return `Task updated: "${d.title || "?"}" -> ${d.status || "?"}`;
    case "playbook-launched":
      return `Playbook "${d.playbook || "?"}" launched`;
    case "session-stopped":
      return "Session stopped";
    default:
      return event.type;
  }
}

// ── Markdown generation ──────────────────────────────────────

function generateMarkdown(data: ReportData): string {
  const lines: string[] = [];
  const hr = "---";

  lines.push(`# Session Report: ${data.session.name}`);
  lines.push("");
  lines.push(`**Generated:** ${fmtDate(data.generatedAt)}`);
  lines.push(`**Session ID:** \`${data.session.id}\``);
  lines.push(`**Status:** ${data.session.status}`);
  if (data.session.projectPath) {
    lines.push(`**Project:** \`${data.session.projectPath}\``);
  }
  if (data.session.createdAt) {
    lines.push(`**Created:** ${fmtDate(data.session.createdAt)}`);
  }
  lines.push("");
  lines.push(hr);

  // Task summary
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Done | ${data.tasks.done} |`);
  lines.push(`| In Progress | ${data.tasks.inProgress} |`);
  lines.push(`| Review | ${data.tasks.review} |`);
  lines.push(`| Pending | ${data.tasks.pending} |`);
  lines.push(`| **Total** | **${data.tasks.total}** |`);
  lines.push("");

  if (data.tasks.items.length > 0) {
    lines.push("### All Tasks");
    lines.push("");
    lines.push("| Priority | Title | Status | Assigned To |");
    lines.push("|----------|-------|--------|-------------|");
    for (const t of data.tasks.items) {
      lines.push(`| ${t.priority} | ${t.title} | ${t.status} | ${t.assignedTo || "Unassigned"} |`);
    }
    lines.push("");
  }

  lines.push(hr);

  // Agent breakdown
  lines.push("");
  lines.push("## Agents");
  lines.push("");
  lines.push("| Agent | Role | Status | Provider | Cost | Tokens In | Tokens Out |");
  lines.push("|-------|------|--------|----------|------|-----------|------------|");
  for (const a of data.agents) {
    const cost = a.costUsd > 0 ? `$${a.costUsd.toFixed(2)}` : "--";
    lines.push(
      `| ${a.name} | ${a.role} | ${a.status} | ${a.provider}${a.model && a.model !== "default" ? `/${a.model}` : ""} | ${cost} | ${fmtTokens(a.tokensIn)} | ${fmtTokens(a.tokensOut)} |`
    );
  }
  lines.push("");

  lines.push(hr);

  // Cost summary
  lines.push("");
  lines.push("## Cost Summary");
  lines.push("");
  const totalCost = data.cost.total;
  lines.push(`**Total Cost:** ${totalCost > 0 ? `$${totalCost.toFixed(2)}` : "No cost data"}`);
  lines.push("");

  if (data.cost.byAgent.length > 0 && totalCost > 0) {
    lines.push("| Agent | Cost | Tokens In | Tokens Out | % of Total |");
    lines.push("|-------|------|-----------|------------|------------|");
    for (const a of data.cost.byAgent.sort((x, y) => y.cost - x.cost)) {
      const pct = totalCost > 0 ? ((a.cost / totalCost) * 100).toFixed(1) : "0";
      lines.push(
        `| ${a.name} | $${a.cost.toFixed(2)} | ${fmtTokens(a.tokensIn)} | ${fmtTokens(a.tokensOut)} | ${pct}% |`
      );
    }
    lines.push("");
  }

  lines.push(hr);

  // Event summary
  lines.push("");
  lines.push("## Event Summary");
  lines.push("");
  lines.push(`**Total Events:** ${data.events.total}`);
  lines.push("");

  if (Object.keys(data.events.byType).length > 0) {
    lines.push("| Event Type | Count |");
    lines.push("|------------|-------|");
    const sorted = Object.entries(data.events.byType).sort(([, a], [, b]) => b - a);
    for (const [type, count] of sorted) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push("");
  }

  // Key events timeline
  if (data.events.recent.length > 0) {
    lines.push("### Key Events Timeline");
    lines.push("");
    lines.push("| Time | Event | Details |");
    lines.push("|------|-------|---------|");
    for (const e of data.events.recent) {
      const time = new Date(e.timestamp).toLocaleTimeString();
      lines.push(`| ${time} | ${e.type} | ${e.summary} |`);
    }
    lines.push("");
  }

  lines.push(hr);
  lines.push("");
  lines.push(`*Report generated by Kora*`);

  return lines.join("\n");
}

// ── Component ────────────────────────────────────────────────

export function SessionReport({
  sessionId,
  sessionName,
  agents,
  opened,
  onClose,
}: SessionReportProps) {
  const api = useApi();
  const [loading, setLoading] = useState(false);
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [markdown, setMarkdown] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const generateReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sessionRes, tasksRes, eventsRes] = await Promise.all([
        api.getSession(sessionId),
        api.getTasks(sessionId),
        api.getEvents(sessionId, { limit: 1000 }),
      ]);

      const session = sessionRes as any;
      const tasks = tasksRes.tasks || [];
      const events = eventsRes.events || [];

      // Build agent data with costs
      const agentData = agents.map((a) => {
        const { tokensIn, tokensOut, costUsd } = extractCostData(a);
        return {
          name: a.config?.name || a.name || "Agent",
          id: a.id,
          role: a.role || "worker",
          status: a.status || "unknown",
          provider: a.config?.cliProvider || a.provider || "unknown",
          model: a.config?.model || a.model || "default",
          tokensIn,
          tokensOut,
          costUsd,
          startedAt: a.startedAt,
        };
      });

      // Task breakdown
      const taskData = {
        total: tasks.length,
        done: tasks.filter((t: any) => t.status === "done").length,
        inProgress: tasks.filter((t: any) => t.status === "in-progress").length,
        review: tasks.filter((t: any) => t.status === "review").length,
        pending: tasks.filter((t: any) => t.status === "pending").length,
        items: tasks.map((t: any) => ({
          title: t.title,
          status: t.status,
          assignedTo: t.assignedTo,
          priority: t.priority || "P2",
        })),
      };

      // Event breakdown
      const byType: Record<string, number> = {};
      for (const e of events) {
        byType[e.type] = (byType[e.type] || 0) + 1;
      }

      // Pick key events (exclude high-frequency message events)
      const keyEventTypes = new Set([
        "agent-spawned", "agent-removed", "agent-crashed", "agent-restarted",
        "task-created", "task-completed", "playbook-launched",
        "session-created", "session-stopped", "session-paused",
      ]);
      const keyEvents = events
        .filter((e: any) => keyEventTypes.has(e.type))
        .slice(0, 50)
        .map((e: any) => ({
          type: e.type,
          timestamp: e.timestamp,
          summary: summarizeEvent(e),
        }));

      // Cost summary
      const costByAgent = agentData.map((a) => ({
        name: a.name,
        cost: a.costUsd,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
      }));
      const totalCost = costByAgent.reduce((sum, a) => sum + a.cost, 0);

      const report: ReportData = {
        session: {
          name: session?.name || sessionName,
          id: sessionId,
          status: session?.status || "unknown",
          projectPath: session?.projectPath,
          createdAt: session?.createdAt,
        },
        agents: agentData,
        tasks: taskData,
        events: {
          total: events.length,
          byType,
          recent: keyEvents,
        },
        cost: {
          total: totalCost,
          byAgent: costByAgent,
        },
        generatedAt: new Date().toISOString(),
      };

      const md = generateMarkdown(report);
      setReportData(report);
      setMarkdown(md);
    } catch (err: any) {
      setError(err.message || "Failed to generate report");
    } finally {
      setLoading(false);
    }
  }, [sessionId, sessionName, agents, api]);

  // Generate on open
  const handleOpened = useCallback(() => {
    if (opened && !reportData && !loading) {
      generateReport();
    }
  }, [opened, reportData, loading, generateReport]);

  // Trigger generation when modal opens
  if (opened && !reportData && !loading && !error) {
    handleOpened();
  }

  const handleDownload = () => {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kora-report-${sessionId}-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      // fallback
      const textarea = document.createElement("textarea");
      textarea.value = markdown;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  const modalStyles = {
    header: {
      backgroundColor: "var(--bg-secondary)",
      borderBottom: "1px solid var(--border-color)",
    },
    body: {
      backgroundColor: "var(--bg-secondary)",
      overflowY: "auto" as const,
      maxHeight: "calc(85vh - 80px)",
      padding: "16px 24px 24px",
    },
    content: {
      backgroundColor: "var(--bg-secondary)",
      maxHeight: "85vh",
      display: "flex" as const,
      flexDirection: "column" as const,
    },
    inner: {
      padding: "20px 0",
    },
    title: {
      color: "var(--text-primary)",
      fontWeight: 600 as const,
      fontSize: 18,
    },
    close: { color: "var(--text-secondary)" },
  };

  return (
    <Modal
      opened={opened}
      onClose={() => {
        onClose();
        // Reset state for fresh generation next time
        setReportData(null);
        setMarkdown("");
        setError(null);
      }}
      title="Session Report"
      size="xl"
      centered
      styles={modalStyles}
    >
      {loading && (
        <Stack align="center" py="xl" gap="md">
          <Loader size="md" color="blue" />
          <Text size="sm" c="dimmed">Generating report...</Text>
        </Stack>
      )}

      {error && (
        <Stack align="center" py="xl" gap="md">
          <Text size="sm" c="red">{error}</Text>
          <Button variant="light" color="blue" onClick={generateReport}>
            Retry
          </Button>
        </Stack>
      )}

      {reportData && !loading && (
        <Stack gap="md">
          {/* Quick stats bar */}
          <Group gap="md" wrap="wrap">
            <Paper
              p="sm"
              withBorder
              style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", flex: 1, minWidth: 120 }}
            >
              <Text size="xs" c="dimmed" mb={2}>Agents</Text>
              <Text fw={700} size="lg" c="var(--text-primary)">{reportData.agents.length}</Text>
            </Paper>
            <Paper
              p="sm"
              withBorder
              style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", flex: 1, minWidth: 120 }}
            >
              <Text size="xs" c="dimmed" mb={2}>Tasks Done</Text>
              <Text fw={700} size="lg" c="var(--accent-green)">
                {reportData.tasks.done}/{reportData.tasks.total}
              </Text>
            </Paper>
            <Paper
              p="sm"
              withBorder
              style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", flex: 1, minWidth: 120 }}
            >
              <Text size="xs" c="dimmed" mb={2}>Total Cost</Text>
              <Text fw={700} size="lg" c="var(--text-primary)">
                {reportData.cost.total > 0 ? `$${reportData.cost.total.toFixed(2)}` : "--"}
              </Text>
            </Paper>
            <Paper
              p="sm"
              withBorder
              style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", flex: 1, minWidth: 120 }}
            >
              <Text size="xs" c="dimmed" mb={2}>Events</Text>
              <Text fw={700} size="lg" c="var(--text-primary)">{reportData.events.total}</Text>
            </Paper>
          </Group>

          <Divider color="var(--border-color)" />

          {/* Rendered markdown preview */}
          <ScrollArea mah={400} type="auto" offsetScrollbars>
            <Paper
              p="md"
              style={{
                backgroundColor: "var(--bg-tertiary)",
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <MarkdownText>{markdown}</MarkdownText>
            </Paper>
          </ScrollArea>

          <Divider color="var(--border-color)" />

          {/* Actions */}
          <Group justify="space-between">
            <Group gap="xs">
              <Tooltip label="Regenerate report with latest data">
                <Button
                  variant="light"
                  color="gray"
                  size="sm"
                  onClick={generateReport}
                  loading={loading}
                >
                  Regenerate
                </Button>
              </Tooltip>
            </Group>
            <Group gap="xs">
              <Button
                variant="light"
                color="blue"
                size="sm"
                onClick={handleCopy}
              >
                Copy Markdown
              </Button>
              <Button
                color="blue"
                size="sm"
                onClick={handleDownload}
              >
                Download Report
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
