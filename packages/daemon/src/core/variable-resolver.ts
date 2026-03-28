/**
 * Variable resolver for workflow notification templates.
 *
 * Resolves {task.title}, {task.id}, {task.priority}, {task.status},
 * {newState.label}, {newState.id}, {oldState.label}, {oldState.id},
 * {agent.name}, {agent.id}, {baseBranch}, {sessionId} in templates.
 */

export interface ResolverContext {
  task?: {
    id?: string;
    title?: string;
    priority?: string;
    status?: string;
    assignedTo?: string;
  };
  newState?: {
    id?: string;
    label?: string;
  };
  oldState?: {
    id?: string;
    label?: string;
  };
  agent?: {
    id?: string;
    name?: string;
  };
  baseBranch?: string;
  sessionId?: string;
}

/**
 * Resolve {dotted.path} variables in a template string.
 * Unknown variables are left as-is.
 */
export function resolveVariables(template: string, ctx: ResolverContext): string {
  return template.replace(/\{([\w.]+)\}/g, (_match, path: string) => {
    const value = resolvePath(ctx as unknown as Record<string, unknown>, path);
    return value !== undefined ? String(value) : `{${path}}`;
  });
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Build a state transition notification message with runbook.
 */
export function buildTransitionNotification(ctx: ResolverContext, instructions?: string): string {
  const taskTitle = ctx.task?.title || "Unknown task";
  const newLabel = ctx.newState?.label || ctx.newState?.id || "unknown";
  const taskId = ctx.task?.id || "?";
  const priority = ctx.task?.priority || "P2";

  let message = `📋 Task "${taskTitle}" has entered **${newLabel}**.`;

  if (instructions) {
    const resolved = resolveVariables(instructions, ctx);
    message += `\n\n**Your instructions:**\n${resolved}`;
  }

  message += `\n\nTask ID: ${taskId} | Priority: ${priority}`;

  return message;
}

/**
 * Build a backward movement notification.
 */
export function buildBackwardNotification(ctx: ResolverContext, reason?: string): string {
  const taskTitle = ctx.task?.title || "Unknown task";
  const oldLabel = ctx.oldState?.label || ctx.oldState?.id || "unknown";
  const newLabel = ctx.newState?.label || ctx.newState?.id || "unknown";

  let message = `⚠️ Task "${taskTitle}" moved backward: **${oldLabel}** → **${newLabel}**.`;
  if (reason) {
    message += ` Reason: ${reason}`;
  }
  message += `\n\nTask ID: ${ctx.task?.id || "?"} | Priority: ${ctx.task?.priority || "P2"}`;
  return message;
}

/**
 * Build a reassignment notification.
 */
export function buildReassignmentNotification(ctx: ResolverContext, fromAgent?: string): string {
  const taskTitle = ctx.task?.title || "Unknown task";
  let message = `🔄 Task "${taskTitle}" has been reassigned to you.`;
  if (fromAgent) {
    message += ` (Previously assigned to ${fromAgent})`;
  }
  const stateLabel = ctx.newState?.label || ctx.task?.status || "unknown";
  message += `\nCurrent state: **${stateLabel}**`;
  message += `\n\nTask ID: ${ctx.task?.id || "?"} | Priority: ${ctx.task?.priority || "P2"}`;
  return message;
}

/**
 * Build a cancellation notification.
 */
export function buildCancellationNotification(ctx: ResolverContext): string {
  const taskTitle = ctx.task?.title || "Unknown task";
  return `🚫 Task "${taskTitle}" has been cancelled/closed.\n\nTask ID: ${ctx.task?.id || "?"} | Final state: ${ctx.newState?.label || "done"}`;
}
