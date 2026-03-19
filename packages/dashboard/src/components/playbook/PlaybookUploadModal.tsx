import { useState } from "react";
import { Modal, Button, FileInput, Stack, Text, Alert, Code, Group, Loader } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

interface ParsedPlaybookAgent {
  name: string;
  role: string;
  provider?: string;
  model?: string;
}

interface ParsedPlaybook {
  name?: string;
  description?: string;
  agents?: ParsedPlaybookAgent[];
}

interface PlaybookUploadModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function PlaybookUploadModal({ opened, onClose, onSuccess }: PlaybookUploadModalProps) {
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ParsedPlaybook | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  async function handleFileChange(selectedFile: File | null) {
    setFile(selectedFile);
    setPreview(null);
    setError("");
    setWarnings([]);

    if (!selectedFile) return;

    // Validate file type
    if (!selectedFile.name.endsWith(".yaml") && !selectedFile.name.endsWith(".yml")) {
      setError("Please upload a .yaml or .yml file");
      return;
    }

    setParsing(true);
    try {
      const content = await selectedFile.text();

      // Use js-yaml to parse (need to add this dependency)
      const yaml = await import("js-yaml");
      const parsed = yaml.load(content) as ParsedPlaybook;

      // Basic validation
      const validationErrors: string[] = [];
      const validationWarnings: string[] = [];

      if (!parsed.name) validationErrors.push("Playbook name is required");
      if (!parsed.agents || parsed.agents.length === 0) {
        validationErrors.push("At least one agent is required");
      }

      // Check for master agent
      const masterCount = parsed.agents?.filter((a) => a.role === "master").length || 0;
      if (masterCount === 0) {
        validationErrors.push("At least one master agent is required");
      } else if (masterCount > 1) {
        validationWarnings.push("Multiple master agents found - only first will orchestrate");
      }

      if (validationErrors.length > 0) {
        setError(validationErrors.join("; "));
      } else {
        setPreview(parsed);
        setWarnings(validationWarnings);
      }
    } catch (err: any) {
      setError(`Failed to parse YAML: ${err.message}`);
    } finally {
      setParsing(false);
    }
  }

  async function handleUpload() {
    if (!preview || !file) return;

    setUploading(true);
    setError("");

    try {
      const content = await file.text();

      const response = await fetch("/api/v1/playbooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${localStorage.getItem("kora_token") || ""}`,
        },
        body: JSON.stringify({ yaml: content }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Upload failed: ${response.statusText}`);
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to upload playbook");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Upload Playbook"
      size="lg"
      fullScreen={isMobile}
      centered
      styles={{
        header: {
          backgroundColor: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-color)",
        },
        body: { backgroundColor: "var(--bg-secondary)" },
        content: { backgroundColor: "var(--bg-secondary)" },
        title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 18 },
        close: { color: "var(--text-secondary)" },
      }}
    >
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        {warnings.length > 0 && (
          <Alert color="yellow" variant="light">
            <Stack gap="xs">
              {warnings.map((w, i) => (
                <Text key={i} size="sm">
                  ⚠️ {w}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}

        <FileInput
          label="Playbook File"
          placeholder="Select .yaml or .yml file"
          accept=".yaml,.yml"
          value={file}
          onChange={handleFileChange}
          disabled={uploading}
          styles={{
            label: { color: "var(--text-secondary)", fontSize: 13 },
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
            },
          }}
        />

        {parsing && (
          <Group>
            <Loader size="sm" />
            <Text size="sm" c="var(--text-secondary)">
              Parsing YAML...
            </Text>
          </Group>
        )}

        {preview && (
          <div>
            <Text size="sm" fw={600} c="var(--text-primary)" mb="xs">
              Preview
            </Text>
            <Code
              block
              style={{
                backgroundColor: "var(--bg-tertiary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                maxHeight: 300,
                overflow: "auto",
              }}
            >
              <Text size="xs">
                <strong>Name:</strong> {preview.name}
                <br />
                <strong>Description:</strong> {preview.description || "N/A"}
                <br />
                <strong>Agents:</strong> {preview.agents?.length || 0}
                <br />
                {preview.agents?.map((a, i) => (
                  <div key={i} style={{ marginLeft: 16 }}>
                    • {a.name} ({a.role})
                  </div>
                ))}
              </Text>
            </Code>
          </div>
        )}

        <Group justify="flex-end" mt="md">
          <Button
            variant="default"
            onClick={onClose}
            disabled={uploading}
            styles={{
              root: {
                backgroundColor: "var(--bg-tertiary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
              },
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={!preview || uploading}
            loading={uploading}
            styles={{
              root: {
                backgroundColor: "var(--accent-blue)",
                borderColor: "var(--accent-blue)",
              },
            }}
          >
            {uploading ? "Uploading..." : "Upload Playbook"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
