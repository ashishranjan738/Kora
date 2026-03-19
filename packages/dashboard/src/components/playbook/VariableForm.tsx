import { Stack, TextInput, Select, Text } from "@mantine/core";

interface VariableDefinition {
  description?: string;
  default?: string;
  options?: string[];
}

interface VariableFormProps {
  variables: Record<string, VariableDefinition>;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

export function VariableForm({ variables, values, onChange }: VariableFormProps) {
  if (Object.keys(variables).length === 0) {
    return null;
  }

  return (
    <Stack gap="md">
      {Object.entries(variables).map(([key, def]) => {
        const value = values[key] ?? def.default ?? "";
        const hasOptions = def.options && def.options.length > 0;

        return (
          <div key={key}>
            {hasOptions ? (
              <Select
                label={def.description || key}
                value={value}
                onChange={(v) => onChange(key, v || "")}
                data={def.options!.map((opt) => ({ value: opt, label: opt }))}
                placeholder={`Select ${key}...`}
                required={!def.default}
                styles={{
                  label: { color: "var(--text-secondary)", fontSize: 13 },
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
            ) : (
              <TextInput
                label={def.description || key}
                value={value}
                onChange={(e) => onChange(key, e.currentTarget.value)}
                placeholder={def.default || `Enter ${key}...`}
                required={!def.default}
                styles={{
                  label: { color: "var(--text-secondary)", fontSize: 13 },
                  input: {
                    backgroundColor: "var(--bg-tertiary)",
                    borderColor: "var(--border-color)",
                    color: "var(--text-primary)",
                  },
                }}
              />
            )}
            {def.default && (
              <Text size="xs" c="var(--text-muted)" mt={4}>
                Default: {def.default}
              </Text>
            )}
          </div>
        );
      })}
    </Stack>
  );
}
