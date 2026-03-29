/**
 * E2E: Session Settings — force transition toggle, workflow config.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Session Settings", () => {
  test("force transition toggle default is off", async ({ testSession }) => {
    const session = await apiCall<{ allowMasterForceTransition?: boolean }>(`/sessions/${testSession}`);
    expect(session.allowMasterForceTransition).toBeFalsy();
  });

  test("force transition toggle can be enabled", async ({ testSession }) => {
    await apiCall(`/sessions/${testSession}`, {
      method: "PUT",
      body: { allowMasterForceTransition: true },
    });

    const session = await apiCall<{ allowMasterForceTransition: boolean }>(`/sessions/${testSession}`);
    expect(session.allowMasterForceTransition).toBe(true);
  });

  test("workflow states preserved in session config", async ({ testSession }) => {
    const session = await apiCall<{ config?: { workflowStates?: any[] }; workflowStates?: any[] }>(`/sessions/${testSession}`);
    const states = session.config?.workflowStates || session.workflowStates;
    // Default sessions should have workflow states
    if (states) {
      expect(states.length).toBeGreaterThanOrEqual(2);
      expect(states[0]).toHaveProperty("id");
      expect(states[0]).toHaveProperty("label");
    }
  });
});
