import { Card, Badge, Group, Text, Stack } from "@mantine/core";

interface PlaybookCardProps {
  name: string;
  description?: string;
  agentCount: number;
  source: "builtin" | "global" | "project";
  tags?: string[];
  onClick: () => void;
  selected?: boolean;
}

export function PlaybookCard({
  name,
  description,
  agentCount,
  source,
  tags = [],
  onClick,
  selected = false,
}: PlaybookCardProps) {
  const sourceBadgeColor = {
    builtin: "blue",
    global: "gray",
    project: "green",
  }[source];

  const sourceIcon = {
    builtin: "⚙️",
    global: "🌐",
    project: "📁",
  }[source];

  return (
    <Card
      shadow="sm"
      padding="md"
      radius="md"
      withBorder
      onClick={onClick}
      style={{
        cursor: "pointer",
        borderColor: selected ? "var(--accent-blue)" : "var(--border-color)",
        borderWidth: selected ? 2 : 1,
        backgroundColor: selected ? "var(--bg-tertiary)" : "var(--bg-secondary)",
        transition: "all 0.2s ease",
      }}
      styles={{
        root: {
          "&:hover": {
            borderColor: "var(--accent-blue)",
            transform: "translateY(-2px)",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
          },
        },
      }}
    >
      <Stack gap="xs">
        <div>
          <Text fw={600} size="md" c="var(--text-primary)" mb={4}>
            {name}
          </Text>
          <Badge color={sourceBadgeColor} variant="light" size="sm">
            {sourceIcon} {source}
          </Badge>
        </div>

        {description && (
          <Text size="sm" c="var(--text-secondary)" lineClamp={2}>
            {description}
          </Text>
        )}

        <Group gap="xs" mt="xs">
          <Badge color="gray" variant="dot" size="sm">
            {agentCount} agent{agentCount !== 1 ? "s" : ""}
          </Badge>
          {tags.map((tag) => (
            <Badge key={tag} color="grape" variant="light" size="sm">
              {tag}
            </Badge>
          ))}
        </Group>
      </Stack>
    </Card>
  );
}
