import { Stack, Text, Badge, Group, Divider, Paper, Collapse } from "@mantine/core";
import { useState } from "react";
import { VariableForm } from "./VariableForm";

interface PlaybookAgent {
  name: string;
  role: string;
  provider?: string;
  model?: string;
  persona?: string;
}

interface VariableDefinition {
  description?: string;
  default?: string;
  options?: string[];
}

interface PlaybookPreviewProps {
  playbook: {
    name: string;
    description?: string;
    agents: PlaybookAgent[];
    variables?: Record<string, VariableDefinition>;
    tags?: string[];
  };
  variableValues: Record<string, string>;
  onVariableChange: (key: string, value: string) => void;
}

export function PlaybookPreview({
  playbook,
  variableValues,
  onVariableChange,
}: PlaybookPreviewProps) {
  const [agentsExpanded, setAgentsExpanded] = useState(true);

  return (
    <Stack gap="md">
      <div>
        <Text size="xl" fw={600} c="var(--text-primary)">
          {playbook.name}
        </Text>
        {playbook.description && (
          <Text size="sm" c="var(--text-secondary)" mt={4}>
            {playbook.description}
          </Text>
        )}
      </div>

      {playbook.tags && playbook.tags.length > 0 && (
        <Group gap="xs">
          {playbook.tags.map((tag) => (
            <Badge key={tag} color="grape" variant="light" size="sm">
              {tag}
            </Badge>
          ))}
        </Group>
      )}

      <Divider />

      {/* Variables Section */}
      {playbook.variables && Object.keys(playbook.variables).length > 0 && (
        <div>
          <Text size="sm" fw={600} c="var(--text-primary)" mb="sm">
            Variables
          </Text>
          <VariableForm
            variables={playbook.variables}
            values={variableValues}
            onChange={onVariableChange}
          />
        </div>
      )}

      {/* Agents Section */}
      <div>
        <Group
          justify="space-between"
          style={{ cursor: "pointer" }}
          onClick={() => setAgentsExpanded(!agentsExpanded)}
        >
          <Text size="sm" fw={600} c="var(--text-primary)">
            Agents ({playbook.agents.length})
          </Text>
          <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
            {agentsExpanded ? "▼" : "▶"}
          </span>
        </Group>

        <Collapse in={agentsExpanded}>
          <Stack gap="xs" mt="sm">
            {playbook.agents.map((agent, i) => (
              <Paper
                key={i}
                p="sm"
                withBorder
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  borderColor: "var(--border-color)",
                }}
              >
                <Group justify="space-between">
                  <div>
                    <Group gap="xs">
                      <Text size="sm" fw={500} c="var(--text-primary)">
                        {agent.name}
                      </Text>
                      <Badge
                        color={agent.role === "master" ? "yellow" : "blue"}
                        variant="light"
                        size="sm"
                      >
                        {agent.role}
                      </Badge>
                    </Group>
                    {(agent.provider || agent.model) && (
                      <Text size="xs" c="var(--text-secondary)" mt={4}>
                        {[agent.provider, agent.model].filter(Boolean).join(" / ")}
                      </Text>
                    )}
                  </div>
                </Group>

                {agent.persona && (
                  <Text
                    size="xs"
                    c="var(--text-muted)"
                    mt="xs"
                    lineClamp={2}
                    style={{ fontStyle: "italic" }}
                  >
                    {agent.persona.substring(0, 100)}
                    {agent.persona.length > 100 ? "..." : ""}
                  </Text>
                )}
              </Paper>
            ))}
          </Stack>
        </Collapse>
      </div>
    </Stack>
  );
}
