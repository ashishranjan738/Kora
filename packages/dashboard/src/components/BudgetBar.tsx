import { Group, Text, Tooltip, Progress, Alert, Badge } from "@mantine/core";
import { formatCost } from "../utils/formatters";

// ---------- Types ----------

interface BudgetBarProps {
  currentCost: number;
  budgetLimit?: number; // undefined = no limit
  warningThreshold?: number; // default 0.8 (80%)
  compact?: boolean;
}

// ---------- Component ----------

export function BudgetBar({
  currentCost,
  budgetLimit,
  warningThreshold = 0.8,
  compact = false,
}: BudgetBarProps) {
  if (!budgetLimit || budgetLimit <= 0) {
    // No budget set — just show current cost
    if (compact) return null;
    return (
      <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
        Cost: {formatCost(currentCost)} (no limit)
      </Text>
    );
  }

  const pct = Math.min((currentCost / budgetLimit) * 100, 100);
  const isWarning = pct >= warningThreshold * 100;
  const isExceeded = currentCost >= budgetLimit;

  const barColor = isExceeded ? "red" : isWarning ? "yellow" : "blue";

  if (compact) {
    return (
      <Tooltip label={`${formatCost(currentCost)} / ${formatCost(budgetLimit)} (${Math.round(pct)}%)`}>
        <div style={{ width: 60, display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <Progress value={pct} color={barColor} size="xs" style={{ flex: 1 }} />
          <Text size="xs" c={isExceeded ? "red" : isWarning ? "yellow" : "dimmed"} fw={isWarning ? 600 : 400}>
            {Math.round(pct)}%
          </Text>
        </div>
      </Tooltip>
    );
  }

  return (
    <div style={{ minWidth: 140 }}>
      <Group justify="space-between" gap={4} mb={2}>
        <Text size="xs" c="dimmed">Budget</Text>
        <Text size="xs" fw={500} c={isExceeded ? "red" : isWarning ? "yellow" : undefined}>
          {formatCost(currentCost)} / {formatCost(budgetLimit)}
        </Text>
      </Group>
      <Progress value={pct} color={barColor} size="sm" />
    </div>
  );
}

// ---------- Budget Warning Alert ----------

interface BudgetWarningProps {
  currentCost: number;
  budgetLimit?: number;
  warningThreshold?: number;
  onDismiss?: () => void;
}

export function BudgetWarning({ currentCost, budgetLimit, warningThreshold = 0.8, onDismiss }: BudgetWarningProps) {
  if (!budgetLimit || budgetLimit <= 0) return null;

  const pct = (currentCost / budgetLimit) * 100;
  const isExceeded = currentCost >= budgetLimit;
  const isWarning = pct >= warningThreshold * 100;

  if (!isWarning) return null;

  return (
    <Alert
      color={isExceeded ? "red" : "orange"}
      variant="light"
      withCloseButton={!!onDismiss}
      onClose={onDismiss}
      title={
        <Group gap="xs">
          <Text fw={600}>
            {isExceeded ? "Budget exceeded!" : "Budget warning"}
          </Text>
          <Badge size="xs" color={isExceeded ? "red" : "orange"} variant="filled">
            {Math.round(pct)}%
          </Badge>
        </Group>
      }
    >
      <Text size="sm">
        {isExceeded
          ? `Session cost (${formatCost(currentCost)}) has exceeded the budget limit (${formatCost(budgetLimit)}). Agents may be auto-paused.`
          : `Session cost (${formatCost(currentCost)}) is approaching the budget limit (${formatCost(budgetLimit)}). Consider pausing non-essential agents.`
        }
      </Text>
    </Alert>
  );
}
