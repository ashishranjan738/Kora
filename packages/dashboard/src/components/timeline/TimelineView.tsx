import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useApi } from "../../hooks/useApi";
import { useWebSocket } from "../../hooks/useWebSocket";
import { TimelineFilters, type EventFilter, type DensityMode } from "./TimelineFilters";
import { TimelineEvent, type TimelineEventData } from "./TimelineEvent";
import { DateDivider, getDateLabel, getDateKey } from "./DateDivider";
import { Badge, Loader, Text } from "@mantine/core";

interface TimelineViewProps {
  sessionId: string;
  agents: Array<{ id: string; name: string; config?: { name?: string } }>;
  onJumpToTerminal?: (agentId: string) => void;
  onJumpToTaskBoard?: () => void;
  onRestartAgent?: (agentId: string) => void;
}

// Event type filter groups
const FILTER_GROUPS: Record<EventFilter, string[] | null> = {
  all: null,
  agents: ["agent-spawned", "agent-removed", "agent-crashed", "agent-restarted"],
  messages: ["message-sent"],
  tasks: ["task-created", "task-updated", "task-deleted"],
  system: ["session-created", "session-paused", "session-resumed", "session-stopped"],
};

export function TimelineView({
  sessionId,
  agents,
  onJumpToTerminal,
  onJumpToTaskBoard,
  onRestartAgent,
}: TimelineViewProps) {
  const api = useApi();
  const [events, setEvents] = useState<TimelineEventData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<EventFilter>("all");
  const [density, setDensity] = useState<DensityMode>("normal");
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [liveMode, setLiveMode] = useState(true);
  const [newEventCount, setNewEventCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEventCountRef = useRef(0);

  // Agent list for filter dropdown
  const agentOptions = useMemo(
    () => agents.map((a) => ({ id: a.id, name: a.config?.name || a.name || a.id })),
    [agents]
  );

  // Fetch events
  const fetchEvents = useCallback(async () => {
    try {
      const data = await api.getEvents(sessionId, 200);
      const sorted = (data.events || []).sort(
        (a: TimelineEventData, b: TimelineEventData) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      setEvents(sorted);

      // Track new events for banner
      if (lastEventCountRef.current > 0 && sorted.length > lastEventCountRef.current) {
        setNewEventCount((prev) => prev + (sorted.length - lastEventCountRef.current));
      }
      lastEventCountRef.current = sorted.length;
    } catch (err) {
      console.debug("[timeline] Failed to fetch events:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    fetchEvents();
  }, [sessionId, fetchEvents]);

  // Polling (slower when not in live mode)
  useEffect(() => {
    const interval = setInterval(fetchEvents, liveMode ? 3000 : 15000);
    return () => clearInterval(interval);
  }, [fetchEvents, liveMode]);

  // WebSocket for live updates
  const handleWsEvent = useCallback(
    (wsEvent: any) => {
      if (!liveMode) return;
      const eid = wsEvent.sessionId || wsEvent.data?.sessionId;
      if (eid && eid !== sessionId) return;
      fetchEvents();
    },
    [sessionId, liveMode, fetchEvents]
  );
  useWebSocket(handleWsEvent);

  // Filter events
  const filteredEvents = useMemo(() => {
    let result = events;

    // Type filter
    const allowedTypes = FILTER_GROUPS[filter];
    if (allowedTypes) {
      result = result.filter((evt) => allowedTypes.includes(evt.type));
    }

    // Agent filter
    if (agentFilter) {
      result = result.filter((evt) => {
        const data = (evt.data || {}) as Record<string, string | undefined>;
        return (
          data.agentId === agentFilter ||
          data.from === agentFilter ||
          data.to === agentFilter
        );
      });
    }

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((evt) => {
        const data = (evt.data || {}) as Record<string, string | undefined>;
        return (
          evt.type.toLowerCase().includes(q) ||
          (data.name || "").toLowerCase().includes(q) ||
          (data.content || "").toLowerCase().includes(q) ||
          (data.fromName || "").toLowerCase().includes(q) ||
          (data.toName || "").toLowerCase().includes(q) ||
          (data.title || "").toLowerCase().includes(q) ||
          (evt.description || "").toLowerCase().includes(q)
        );
      });
    }

    return result;
  }, [events, filter, agentFilter, search]);

  // Group events by date
  const groupedEvents = useMemo(() => {
    const groups: Array<{ dateKey: string; label: string; events: TimelineEventData[] }> = [];
    const seen = new Map<string, TimelineEventData[]>();

    for (const evt of filteredEvents) {
      const key = getDateKey(evt.timestamp);
      if (!seen.has(key)) {
        const group = { dateKey: key, label: getDateLabel(evt.timestamp), events: [] as TimelineEventData[] };
        groups.push(group);
        seen.set(key, group.events);
      }
      seen.get(key)!.push(evt);
    }

    return groups;
  }, [filteredEvents]);

  // Dismiss new events banner
  function dismissNewEvents() {
    setNewEventCount(0);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  const densityClass = density === "compact" ? "tl-compact" : density === "detailed" ? "tl-detailed" : "";

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
          Timeline
        </h2>
        <Badge variant="light" color="blue" size="sm">
          {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      <TimelineFilters
        filter={filter}
        onFilterChange={setFilter}
        density={density}
        onDensityChange={setDensity}
        search={search}
        onSearchChange={setSearch}
        agentFilter={agentFilter}
        onAgentFilterChange={setAgentFilter}
        agents={agentOptions}
        liveMode={liveMode}
        onLiveModeChange={setLiveMode}
      />

      {/* New events banner */}
      {newEventCount > 0 && !loading && (
        <div className="tl-new-events-banner" onClick={dismissNewEvents}>
          {newEventCount} new event{newEventCount !== 1 ? "s" : ""} — click to scroll up
        </div>
      )}

      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 24, justifyContent: "center" }}>
          <Loader size="sm" />
          <Text size="sm" c="dimmed">Loading events...</Text>
        </div>
      )}

      {!loading && filteredEvents.length === 0 && (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Text size="lg" c="dimmed" mb={8}>No events yet</Text>
          <Text size="sm" c="dimmed">
            {filter !== "all" || search || agentFilter
              ? "Try adjusting your filters"
              : "Events will appear here as agents work"}
          </Text>
        </div>
      )}

      {!loading && filteredEvents.length > 0 && (
        <div ref={scrollRef} className={`tl-timeline ${densityClass}`}>
          {groupedEvents.map((group) => (
            <div key={group.dateKey}>
              <DateDivider label={group.label} />
              <div className="tl-events">
                {group.events.map((evt, idx) => (
                  <TimelineEvent
                    key={evt.id || `${group.dateKey}-${idx}`}
                    event={evt}
                    density={density}
                    onJumpToTerminal={onJumpToTerminal}
                    onJumpToTaskBoard={onJumpToTaskBoard}
                    onRestart={onRestartAgent}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
