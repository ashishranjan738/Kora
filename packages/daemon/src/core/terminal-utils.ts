/**
 * Terminal utilities — shared helpers for sending notifications to agent terminals.
 */

import type { IPtyBackend } from "./pty-backend.js";

/**
 * Send a notification to an agent's terminal, followed by Enter.
 * Kiro and other CLIs need the Enter keystroke to process input;
 * Claude Code reads terminal passively so Enter is harmless.
 *
 * Uses literal mode (text injected without interpretation) + Enter press.
 */
export async function sendTerminalNotification(
  terminal: IPtyBackend,
  session: string,
  text: string,
): Promise<void> {
  await terminal.sendKeys(session, text, { literal: true });
  await terminal.sendKeys(session, '', { literal: false }); // Press Enter
}
