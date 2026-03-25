/**
 * Terminal utilities — shared helpers for sending notifications to agent terminals.
 */

import type { IPtyBackend } from "./pty-backend.js";

/**
 * Send a notification to an agent's terminal, followed by Enter.
 * Kiro and other CLIs need the Enter keystroke to process input;
 * Claude Code reads terminal passively so Enter is harmless.
 *
 * Collapses multiline text to a single line — multiline input causes
 * Kiro to display the text but not submit it (cursor sits at bottom).
 * LLMs don't need formatting; they parse the content regardless.
 *
 * Uses sendRawInput (raw bytes, no automatic \r) for precise control:
 * two separate writes — text then Enter — to avoid terminal buffer issues
 * with large payloads where sendKeys drops the trailing \r.
 */
export async function sendTerminalNotification(
  terminal: IPtyBackend,
  session: string,
  text: string,
): Promise<void> {
  // Collapse newlines to single line — prevents multiline display issues in Kiro
  const singleLine = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  await terminal.sendRawInput(session, singleLine); // text only, no \r
  await terminal.sendRawInput(session, '\r');         // Enter separately
}
