import { Modal, SimpleGrid, Card, Text, Button, Stack, Group, Badge } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { usePersonas, type Persona } from "../hooks/usePersonas";

interface PersonaLibraryProps {
  opened: boolean;
  onClose: () => void;
  onSelect: (persona: Persona) => void;
}

// Icon mapping for visual variety
const PERSONA_ICONS: Record<string, string> = {
  orchestrator: "🎯",
  backend: "⚙️",
  frontend: "🎨",
  fullstack: "🔧",
  tester: "🧪",
  reviewer: "👁️",
  devops: "🚀",
  researcher: "🔍",
};

function PersonaCard({ persona, onSelect }: { persona: Persona; onSelect: () => void }) {
  const icon = PERSONA_ICONS[persona.id] || "🤖";

  return (
    <Card
      padding="md"
      radius="md"
      style={{
        backgroundColor: "var(--bg-tertiary)",
        borderColor: "var(--border-color)",
        border: "1px solid var(--border-color)",
        cursor: "pointer",
        transition: "all 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--accent-blue)";
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-color)";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Text size="xl" style={{ fontSize: 32 }}>
            {icon}
          </Text>
          <Badge color="blue" variant="light" size="sm">
            pre-built
          </Badge>
        </Group>

        <Text
          size="md"
          fw={600}
          c="var(--text-primary)"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {persona.name}
        </Text>

        <Text
          size="sm"
          c="var(--text-muted)"
          style={{
            minHeight: 40,
            lineHeight: 1.4,
          }}
        >
          {persona.description}
        </Text>

        <Button
          fullWidth
          variant="light"
          onClick={onSelect}
          styles={{
            root: {
              backgroundColor: "var(--accent-blue)",
              color: "white",
              minHeight: 36,
              "&:hover": {
                backgroundColor: "var(--accent-blue-hover, #4a8fd8)",
              },
            },
          }}
        >
          Select Persona
        </Button>
      </Stack>
    </Card>
  );
}

export function PersonaLibrary({ opened, onClose, onSelect }: PersonaLibraryProps) {
  const { personas } = usePersonas();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const isTablet = useMediaQuery("(max-width: 62em)");

  const handleSelect = (persona: Persona) => {
    onSelect(persona);
    onClose();
  };

  // Determine number of columns based on screen size
  const cols = isMobile ? 1 : isTablet ? 2 : 3;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Select Agent Persona"
      size="xl"
      fullScreen={isMobile}
      centered
      styles={{
        header: {
          backgroundColor: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-color)",
        },
        body: {
          backgroundColor: "var(--bg-secondary)",
          padding: isMobile ? 12 : 24,
        },
        content: { backgroundColor: "var(--bg-secondary)" },
        title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 18 },
        close: { color: "var(--text-secondary)" },
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="var(--text-muted)">
          Choose a pre-built persona to quickly configure your agent with specialized capabilities.
          The selected persona will populate the persona field, which you can further customize if needed.
        </Text>

        <SimpleGrid cols={cols} spacing="md">
          {personas.map((persona) => (
            <PersonaCard
              key={persona.id}
              persona={persona}
              onSelect={() => handleSelect(persona)}
            />
          ))}
        </SimpleGrid>

        <Group justify="flex-end" mt="md">
          <Button
            variant="default"
            onClick={onClose}
            styles={{
              root: {
                backgroundColor: "var(--bg-tertiary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                minHeight: 44,
              },
            }}
          >
            Cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
