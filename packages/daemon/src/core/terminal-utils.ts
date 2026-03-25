/**
 * Terminal utilities — shared helpers for sending notifications to agent terminals.
 */

import type { IPtyBackend } from "./pty-backend.js";

/**
 * Send a notification to an agent's terminal, followed by Enter.
 * Kiro and other CLIs need the Enter keystroke to process input;
 * Claude Code reads terminal passively so Enter is harmless.
 *
 * Collapses multiline text to a single line — multiline sendKeys causes
 * Kiro to display the text but not submit it (cursor sits at bottom).
 * LLMs don't need formatting; they parse the content regardless.
 *
 * Uses literal mode (text injected without interpretation) + Enter press.
 */
export async function sendTerminalNotification(
  terminal: IPtyBackend,
  session: string,
  text: string,
): Promise<void> {
  // Collapse newlines to single line — prevents multiline display issues in Kiro
  const singleLine = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  await terminal.sendKeys(session, singleLine, { literal: true });
  await new Promise(r => setTimeout(r, 200)); // let terminal process the text before Enter
  await terminal.sendKeys(session, '', { literal: false }); // Press Enter
}
