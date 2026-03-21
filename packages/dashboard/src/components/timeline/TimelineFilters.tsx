import { SegmentedControl, TextInput, MultiSelect, Switch, Group } from "@mantine/core";

export type EventFilter = "all" | "agents" | "messages" | "tasks" | "system";
export type DensityMode = "compact" | "normal" | "detailed";

interface TimelineFiltersProps {
  filter: EventFilter;
  onFilterChange: (filter: EventFilter) => void;
  density: DensityMode;
  onDensityChange: (density: DensityMode) => void;
  search: string;
  onSearchChange: (search: string) => void;
  agentFilter: string;
  onAgentFilterChange: (agentId: string) => void;
  agents: Array<{ id: string; name: string }>;
  liveMode: boolean;
  onLiveModeChange: (live: boolean) => void;
}

export function TimelineFilters({
  filter,
  onFilterChange,
  density,
  onDensityChange,
  search,
  onSearchChange,
  agentFilter,
  onAgentFilterChange,
  agents,
  liveMode,
  onLiveModeChange,
}: TimelineFiltersProps) {
  return (
    <div>
      {/* Density bar */}
      <div className="tl-density-bar">
        <label>Density</label>
        <SegmentedControl
          size="xs"
          value={density}
          onChange={(val) => onDensityChange(val as DensityMode)}
          data={[
            { label: "Compact", value: "compact" },
            { label: "Normal", value: "normal" },
            { label: "Detailed", value: "detailed" },
          ]}
          styles={{
            root: { backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)" },
          }}
        />
      </div>

      {/* Filter bar */}
      <div className="tl-filter-bar">
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(val) => onFilterChange(val as EventFilter)}
          data={[
            { label: "All", value: "all" },
            { label: "Agents", value: "agents" },
            { label: "Messages", value: "messages" },
            { label: "Tasks", value: "tasks" },
            { label: "System", value: "system" },
          ]}
          styles={{
            root: { backgroundColor: "transparent", border: "1px solid var(--border-color)" },
            control: { minWidth: 72 },
            label: { textAlign: "center" as const, justifyContent: "center" },
          }}
        />

        {agents.length > 0 && (
          <MultiSelect
            size="xs"
            placeholder="All agents"
            value={agentFilter ? agentFilter.split(',').filter(Boolean) : []}
            onChange={(vals) => onAgentFilterChange(vals.join(','))}
            data={agents.map((a) => ({ label: a.name, value: a.id }))}
            clearable
            searchable
            styles={{
              input: {
                backgroundColor: "var(--bg-primary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                minWidth: 150,
              },
            }}
          />
        )}

        <TextInput
          size="xs"
          placeholder="Search events..."
          value={search}
          onChange={(e) => onSearchChange(e.currentTarget.value)}
          leftSection={<span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1 }}>&#128269;</span>}
          leftSectionWidth={30}
          styles={{
            root: { flex: 1, minWidth: 150 },
            input: {
              backgroundColor: "var(--bg-primary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
              paddingLeft: 30,
            },
          }}
        />

        <Group gap={6} ml="auto" style={{ flexShrink: 0 }}>
          {liveMode && <span className="tl-live-dot" />}
          <Switch
            size="xs"
            label="Live"
            checked={liveMode}
            onChange={(e) => onLiveModeChange(e.currentTarget.checked)}
            styles={{
              label: { color: "var(--text-secondary)", fontSize: 12 },
            }}
          />
        </Group>
      </div>
    </div>
  );
}
