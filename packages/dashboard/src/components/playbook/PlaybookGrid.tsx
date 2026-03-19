import { useState, useMemo } from "react";
import { Grid, TextInput, Stack, Group, MultiSelect, Text, Loader } from "@mantine/core";
import { PlaybookCard } from "./PlaybookCard";

interface PlaybookAgent {
  name: string;
  role: string;
  provider?: string;
  model?: string;
  persona?: string;
  initialTask?: string;
}

interface Playbook {
  name: string;
  description?: string;
  agents: PlaybookAgent[];
  source?: "builtin" | "global" | "project";
  tags?: string[];
}

interface PlaybookGridProps {
  playbooks: Playbook[];
  selectedPlaybook: Playbook | null;
  onSelectPlaybook: (playbook: Playbook) => void;
  loading?: boolean;
}

export function PlaybookGrid({
  playbooks,
  selectedPlaybook,
  onSelectPlaybook,
  loading = false,
}: PlaybookGridProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Extract all unique tags from playbooks
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    playbooks.forEach((pb) => {
      pb.tags?.forEach((tag) => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [playbooks]);

  // Filter playbooks based on search and tags
  const filteredPlaybooks = useMemo(() => {
    return playbooks.filter((pb) => {
      // Search filter
      const matchesSearch =
        !searchQuery ||
        pb.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        pb.description?.toLowerCase().includes(searchQuery.toLowerCase());

      // Tag filter
      const matchesTags =
        selectedTags.length === 0 ||
        selectedTags.some((tag) => pb.tags?.includes(tag));

      return matchesSearch && matchesTags;
    });
  }, [playbooks, searchQuery, selectedTags]);

  if (loading) {
    return (
      <Stack align="center" justify="center" style={{ minHeight: 200 }}>
        <Loader size="md" />
        <Text c="var(--text-secondary)">Loading playbooks...</Text>
      </Stack>
    );
  }

  if (playbooks.length === 0) {
    return (
      <Stack align="center" justify="center" style={{ minHeight: 200 }}>
        <Text c="var(--text-secondary)">No playbooks found.</Text>
        <Text size="xs" c="var(--text-muted)">
          Create playbooks in your project to get started.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Group grow>
        <TextInput
          placeholder="Search playbooks..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
          styles={{
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
            },
          }}
        />
        {allTags.length > 0 && (
          <MultiSelect
            placeholder="Filter by tags..."
            data={allTags}
            value={selectedTags}
            onChange={setSelectedTags}
            clearable
            styles={{
              input: {
                backgroundColor: "var(--bg-tertiary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
              },
              dropdown: {
                backgroundColor: "var(--bg-secondary)",
                borderColor: "var(--border-color)",
              },
              option: { color: "var(--text-primary)" },
            }}
          />
        )}
      </Group>

      {filteredPlaybooks.length === 0 ? (
        <Text c="var(--text-secondary)" ta="center" mt="xl">
          No playbooks match your search.
        </Text>
      ) : (
        <Grid gutter="md">
          {filteredPlaybooks.map((pb) => (
            <Grid.Col key={pb.name} span={{ base: 12, sm: 6, md: 4 }}>
              <PlaybookCard
                name={pb.name}
                description={pb.description}
                agentCount={pb.agents?.length || 0}
                source={pb.source || "builtin"}
                tags={pb.tags}
                onClick={() => onSelectPlaybook(pb)}
                selected={selectedPlaybook?.name === pb.name}
              />
            </Grid.Col>
          ))}
        </Grid>
      )}
    </Stack>
  );
}
