import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class NotificationService {
  private enabled = true;

  /** Enable/disable notifications */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Send a desktop notification */
  async notify(title: string, body: string): Promise<void> {
    if (!this.enabled) return;

    try {
      if (process.platform === "darwin") {
        // macOS: use osascript
        await execFileAsync("osascript", [
          "-e",
          `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`,
        ]);
      } else if (process.platform === "linux") {
        // Linux: use notify-send
        await execFileAsync("notify-send", [title, body]);
      } else if (process.platform === "win32") {
        // Windows: use PowerShell toast
        const escapedTitle = escapePowerShell(title);
        const escapedBody = escapePowerShell(body);
        await execFileAsync("powershell", [
          "-Command",
          `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); ` +
            `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
            `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
            `$n.Visible = $true; ` +
            `$n.ShowBalloonTip(5000, '${escapedTitle}', '${escapedBody}', 'Info')`,
        ]);
      }
    } catch {
      // Notification failure is non-fatal, silently ignore
    }
  }

  /** Convenience: notify agent completed */
  async agentCompleted(agentName: string, task: string): Promise<void> {
    await this.notify("Agent Completed", `${agentName} finished: ${task}`);
  }

  /** Convenience: notify agent needs input */
  async agentNeedsInput(agentName: string): Promise<void> {
    await this.notify("Agent Waiting", `${agentName} needs your input`);
  }

  /** Convenience: notify agent crashed */
  async agentCrashed(agentName: string): Promise<void> {
    await this.notify("Agent Crashed", `${agentName} has crashed`);
  }

  /** Convenience: notify budget exceeded */
  async budgetExceeded(agentName: string, cost: number): Promise<void> {
    await this.notify(
      "Budget Exceeded",
      `${agentName} exceeded budget: $${cost.toFixed(2)}`
    );
  }
}

/**
 * Escape a string for safe inclusion in an AppleScript double-quoted string.
 */
function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\n\r]/g, " ")      // Strip newlines — break AppleScript string literals
    .replace(/[\x00-\x1F\x7F]/g, ""); // Strip all other control characters
}

/**
 * Escape a string for safe inclusion in a PowerShell single-quoted string.
 * Single quotes in PowerShell are escaped by doubling them.
 */
function escapePowerShell(str: string): string {
  return str.replace(/'/g, "''");
}

/** Singleton instance for convenient access */
export const notifications = new NotificationService();
