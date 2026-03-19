import { EventEmitter } from "events";

export type NotificationType =
  | "agent-crashed"
  | "agent-idle"
  | "task-complete"
  | "pr-ready"
  | "budget-exceeded";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  sessionId: string;
  agentId?: string;
  timestamp: number;
}

export interface NotificationServiceInterface {
  /**
   * Send an in-app notification (WebSocket broadcast).
   * This is the primary method for in-app notifications.
   */
  sendInApp(notification: Omit<Notification, "id" | "timestamp">): void;

  /**
   * Get recent notifications (last N).
   */
  getRecent(limit: number): Notification[];

  /**
   * Listen for new notifications.
   */
  on(event: "notification", listener: (notification: Notification) => void): void;
  removeListener(
    event: "notification",
    listener: (notification: Notification) => void
  ): void;
}

/**
 * Enhanced notification service that supports in-app notifications
 * via WebSocket events. This builds on the existing desktop notification
 * service and adds a notification queue for the dashboard.
 */
export class EnhancedNotificationService
  extends EventEmitter
  implements NotificationServiceInterface
{
  private notifications: Notification[] = [];
  private maxNotifications = 100;

  /**
   * Send an in-app notification.
   * Stores the notification and emits an event that the WebSocket server can broadcast.
   */
  sendInApp(notification: Omit<Notification, "id" | "timestamp">): void {
    const fullNotification: Notification = {
      ...notification,
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
    };

    // Store notification
    this.notifications.unshift(fullNotification);
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.pop();
    }

    // Emit event for WebSocket broadcast
    this.emit("notification", fullNotification);
  }

  /**
   * Get recent notifications for a specific session (last N).
   */
  getRecentForSession(sessionId: string, limit: number): Notification[] {
    return this.notifications.filter(n => n.sessionId === sessionId).slice(0, limit);
  }

  /**
   * Get recent notifications (last N).
   */
  getRecent(limit: number): Notification[] {
    return this.notifications.slice(0, limit);
  }

  /**
   * Convenience: notify agent crashed.
   */
  agentCrashed(sessionId: string, agentId: string, agentName: string): void {
    this.sendInApp({
      type: "agent-crashed",
      title: "Agent Crashed",
      body: `${agentName} has crashed`,
      sessionId,
      agentId,
    });
  }

  /**
   * Convenience: notify agent idle.
   */
  agentIdle(sessionId: string, agentId: string, agentName: string, idleDuration: number): void {
    this.sendInApp({
      type: "agent-idle",
      title: "Agent Idle",
      body: `${agentName} has been idle for ${Math.floor(idleDuration / 60000)} minutes`,
      sessionId,
      agentId,
    });
  }

  /**
   * Convenience: notify task completed.
   */
  taskCompleted(sessionId: string, taskTitle: string, agentName?: string): void {
    this.sendInApp({
      type: "task-complete",
      title: "Task Completed",
      body: agentName ? `${agentName} completed: ${taskTitle}` : taskTitle,
      sessionId,
    });
  }

  /**
   * Convenience: notify PR ready.
   */
  prReady(sessionId: string, prUrl: string, agentName: string): void {
    this.sendInApp({
      type: "pr-ready",
      title: "PR Ready",
      body: `${agentName} created PR: ${prUrl}`,
      sessionId,
    });
  }

  /**
   * Convenience: notify budget exceeded.
   */
  budgetExceeded(sessionId: string, agentId: string, agentName: string, cost: number): void {
    this.sendInApp({
      type: "budget-exceeded",
      title: "Budget Exceeded",
      body: `${agentName} exceeded budget: $${cost.toFixed(2)}`,
      sessionId,
      agentId,
    });
  }
}

/** Singleton instance for convenient access */
export const notificationService = new EnhancedNotificationService();
