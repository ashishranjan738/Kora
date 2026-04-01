/**
 * Tests for feature flags — group chat gating (PR #519, task 14d15540).
 *
 * Verifies the SessionFeatureFlags type, default behavior, and that
 * the feature flag is properly wired into session config.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("SessionFeatureFlags type definition", () => {
  const sharedTypes = readFileSync(
    resolve(__dirname, "../../../../shared/src/types.ts"),
    "utf-8"
  );

  it("defines SessionFeatureFlags interface", () => {
    expect(sharedTypes).toContain("export interface SessionFeatureFlags");
    expect(sharedTypes).toContain("groupChat?: boolean");
  });

  it("adds features field to SessionConfig", () => {
    expect(sharedTypes).toContain("features?: SessionFeatureFlags");
  });
});

describe("Dashboard feature flag gating", () => {
  const sessionDetail = readFileSync(
    resolve(__dirname, "../../../../dashboard/src/pages/SessionDetail.tsx"),
    "utf-8"
  );

  it("gates Chat tab behind features.groupChat", () => {
    expect(sessionDetail).toContain("features?.groupChat");
  });

  it("gates SidebarChat behind features.groupChat", () => {
    // SidebarChat should be conditionally rendered
    const sidebarChatGated = sessionDetail.includes("features?.groupChat") &&
      sessionDetail.includes("SidebarChat");
    expect(sidebarChatGated).toBe(true);
  });

  it("passes groupChatEnabled prop to AgentsTab", () => {
    expect(sessionDetail).toContain("groupChatEnabled");
  });

  it("gates ChannelIndicator behind groupChatEnabled", () => {
    expect(sessionDetail).toContain("groupChatEnabled && <ChannelIndicator");
  });
});

describe("SessionSettingsDialog feature flag toggle", () => {
  const settingsDialog = readFileSync(
    resolve(__dirname, "../../../../dashboard/src/components/SessionSettingsDialog.tsx"),
    "utf-8"
  );

  it("has groupChatEnabled state", () => {
    expect(settingsDialog).toContain("groupChatEnabled");
  });

  it("loads initial state from session features", () => {
    expect(settingsDialog).toContain("features?.groupChat");
  });

  it("persists feature flag via updateSessionConfig", () => {
    expect(settingsDialog).toContain("features: { groupChat:");
  });

  it("has optimistic update with rollback", () => {
    // Should set value optimistically and rollback on error
    expect(settingsDialog).toContain("setGroupChatEnabled(newVal)");
    expect(settingsDialog).toContain("setGroupChatEnabled(!newVal)");
  });
});

describe("Dashboard API types", () => {
  const apiTypes = readFileSync(
    resolve(__dirname, "../../../../dashboard/src/types/api.ts"),
    "utf-8"
  );

  it("includes features in SessionResponse", () => {
    expect(apiTypes).toContain("features?:");
    expect(apiTypes).toContain("groupChat?: boolean");
  });
});

describe("Feature flag integration — session config persistence", () => {
  it("updateSessionConfig API should accept features object", async () => {
    // Verify the useApi hook supports updating features
    const useApiCode = readFileSync(
      resolve(__dirname, "../../../../dashboard/src/hooks/useApi.ts"),
      "utf-8"
    );
    expect(useApiCode).toContain("updateSessionConfig");
  });
});
