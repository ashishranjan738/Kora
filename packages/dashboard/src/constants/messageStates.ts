/**
 * Shared constants for message state indicators across the dashboard.
 * Used by notification toasts, buffer badges, and other message-related UI components.
 */

export const MESSAGE_STATE_COLORS = {
  unread: { color: 'blue', variant: 'filled' as const },
  buffered: { color: 'yellow', variant: 'light' as const, animation: 'tl-pulse 2s infinite' },
  expired: { color: 'red', variant: 'filled' as const },
} as const;

export type MessageState = keyof typeof MESSAGE_STATE_COLORS;

/**
 * Consistent tooltip/label text for message states.
 * Pass the count to get a formatted label with proper pluralization.
 */
export const MESSAGE_STATE_LABELS = {
  unread: (count: number) => `${count} unread message${count !== 1 ? 's' : ''}`,
  buffered: (count: number) => `${count} message${count !== 1 ? 's' : ''} buffered (rate limited)`,
  expired: (count: number) => `${count} message${count !== 1 ? 's' : ''} expired (delivery failed)`,
} as const;

/**
 * Helper to get both color config and label for a given state.
 */
export function getMessageStateConfig(state: MessageState, count: number) {
  return {
    ...MESSAGE_STATE_COLORS[state],
    label: MESSAGE_STATE_LABELS[state](count),
  };
}
