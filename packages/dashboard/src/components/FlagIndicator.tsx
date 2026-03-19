import { Badge, Popover, Stack, Text, Tooltip, Box } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";

// Simple flag SVG icon (inline to avoid @tabler/icons dep)
function FlagIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

interface FlagIndicatorProps {
  flags: string[];
}

export function FlagIndicator({ flags }: FlagIndicatorProps) {
  const [opened, { open, close }] = useDisclosure(false);

  if (!flags || flags.length === 0) return null;

  // Single short flag: show truncated inline with tooltip
  if (flags.length === 1 && flags[0].length < 20) {
    return (
      <Tooltip label={flags[0]} position="bottom" withArrow>
        <Badge
          variant="light"
          color="yellow"
          size="xs"
          leftSection={<FlagIcon size={9} />}
          style={{ maxWidth: 120, cursor: "default" }}
        >
          <Text size="xs" truncate style={{ maxWidth: 80 }}>
            {flags[0]}
          </Text>
        </Badge>
      </Tooltip>
    );
  }

  // Multiple flags or long single flag: count badge with hover popover
  return (
    <Popover
      opened={opened}
      onClose={close}
      position="bottom"
      withArrow
      shadow="md"
      styles={{
        dropdown: {
          backgroundColor: "var(--bg-secondary)",
          borderColor: "var(--border-color)",
        },
      }}
    >
      <Popover.Target>
        <Badge
          variant="light"
          color="yellow"
          size="xs"
          leftSection={<FlagIcon size={9} />}
          onMouseEnter={open}
          onMouseLeave={close}
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: "pointer" }}
        >
          {flags.length}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown onMouseEnter={open} onMouseLeave={close}>
        <Stack gap={4}>
          <Text size="xs" fw={600} c="var(--text-secondary)" mb={2}>
            CLI Flags
          </Text>
          {flags.map((flag, i) => (
            <Box
              key={i}
              p={4}
              style={{
                backgroundColor: "var(--bg-tertiary)",
                borderRadius: 4,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--accent-yellow)",
                wordBreak: "break-all",
              }}
            >
              {flag}
            </Box>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

// Simple hash SVG icon
function HashIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

interface ChannelIndicatorProps {
  channels: string[];
}

export function ChannelIndicator({ channels }: ChannelIndicatorProps) {
  const [opened, { open, close }] = useDisclosure(false);

  if (!channels || channels.length === 0) return null;

  // Single channel: show inline
  if (channels.length === 1) {
    return (
      <Badge
        variant="dot"
        color="blue"
        size="xs"
        style={{ cursor: "default" }}
      >
        {channels[0]}
      </Badge>
    );
  }

  // Multiple channels: count badge with hover popover
  return (
    <Popover
      opened={opened}
      onClose={close}
      position="bottom"
      withArrow
      shadow="md"
      styles={{
        dropdown: {
          backgroundColor: "var(--bg-secondary)",
          borderColor: "var(--border-color)",
        },
      }}
    >
      <Popover.Target>
        <Badge
          variant="light"
          color="blue"
          size="xs"
          leftSection={<HashIcon size={9} />}
          onMouseEnter={open}
          onMouseLeave={close}
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: "pointer" }}
        >
          {channels.length}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown onMouseEnter={open} onMouseLeave={close}>
        <Stack gap={4}>
          <Text size="xs" fw={600} c="var(--text-secondary)" mb={2}>
            Channels
          </Text>
          {channels.map((ch) => (
            <Badge key={ch} variant="dot" color="blue" size="sm">
              {ch}
            </Badge>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
