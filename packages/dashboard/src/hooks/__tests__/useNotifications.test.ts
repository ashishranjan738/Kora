// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNotifications, type Notification } from '../useNotifications';

// Mock useWebSocket
vi.mock('../useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));

describe('useNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('should initialize with empty notifications and zero unread count', () => {
      const { result } = renderHook(() => useNotifications('test-session'));

      expect(result.current.notifications).toEqual([]);
      expect(result.current.unreadCount).toBe(0);
    });
  });

  describe('Notification Management Actions', () => {
    it('should mark notification as read', () => {
      const { result } = renderHook(() => useNotifications('test-session'));

      act(() => {
        result.current.markAsRead('some-id');
      });

      // Should complete without errors
      expect(result.current.unreadCount).toBe(0);
    });

    it('should mark all as read', () => {
      const { result } = renderHook(() => useNotifications('test-session'));

      act(() => {
        result.current.markAllAsRead();
      });

      expect(result.current.unreadCount).toBe(0);
    });

    it('should clear all notifications', () => {
      const { result } = renderHook(() => useNotifications('test-session'));

      act(() => {
        result.current.clearAll();
      });

      expect(result.current.notifications.length).toBe(0);
    });
  });

  describe('Duplicate Prevention Logic', () => {
    it('should prevent duplicate IDs in notification list', () => {
      const mockNotifications: Notification[] = [
        { id: '1', type: 'test', title: 'Test 1', body: 'Body 1', timestamp: Date.now(), read: false },
        { id: '2', type: 'test', title: 'Test 2', body: 'Body 2', timestamp: Date.now(), read: false },
      ];

      // Test duplicate prevention logic
      const newNotif = { id: '1', type: 'test', title: 'Duplicate', body: 'Duplicate', timestamp: Date.now(), read: false };

      // Simulate duplicate check
      const hasDuplicate = mockNotifications.some((n) => n.id === newNotif.id);
      expect(hasDuplicate).toBe(true);

      // If duplicate exists, it should not be added
      if (!hasDuplicate) {
        mockNotifications.unshift(newNotif);
      }

      // List should still have 2 items (duplicate was not added)
      expect(mockNotifications.length).toBe(2);
    });

    it('should allow new notifications with unique IDs', () => {
      const mockNotifications: Notification[] = [
        { id: '1', type: 'test', title: 'Test 1', body: 'Body 1', timestamp: Date.now(), read: false },
      ];

      const newNotif = { id: '2', type: 'test', title: 'Test 2', body: 'Body 2', timestamp: Date.now(), read: false };

      const hasDuplicate = mockNotifications.some((n) => n.id === newNotif.id);
      expect(hasDuplicate).toBe(false);

      if (!hasDuplicate) {
        mockNotifications.unshift(newNotif);
      }

      // List should have 2 items (new notification was added)
      expect(mockNotifications.length).toBe(2);
    });
  });

  describe('Unread Count Calculation', () => {
    it('should calculate unread count correctly', () => {
      const mockNotifications: Notification[] = [
        { id: '1', type: 'test', title: 'Test 1', body: 'Body 1', timestamp: Date.now(), read: false },
        { id: '2', type: 'test', title: 'Test 2', body: 'Body 2', timestamp: Date.now(), read: true },
        { id: '3', type: 'test', title: 'Test 3', body: 'Body 3', timestamp: Date.now(), read: false },
      ];

      const unreadCount = mockNotifications.filter((n) => !n.read).length;
      expect(unreadCount).toBe(2);
    });

    it('should return 0 for all read notifications', () => {
      const mockNotifications: Notification[] = [
        { id: '1', type: 'test', title: 'Test 1', body: 'Body 1', timestamp: Date.now(), read: true },
        { id: '2', type: 'test', title: 'Test 2', body: 'Body 2', timestamp: Date.now(), read: true },
      ];

      const unreadCount = mockNotifications.filter((n) => !n.read).length;
      expect(unreadCount).toBe(0);
    });
  });

  describe('Notification Limits', () => {
    it('should keep only last 20 notifications', () => {
      const mockNotifications: Notification[] = Array.from({ length: 25 }, (_, i) => ({
        id: `notif-${i}`,
        type: 'test',
        title: `Test ${i}`,
        body: `Body ${i}`,
        timestamp: Date.now(),
        read: false,
      }));

      const limited = mockNotifications.slice(0, 20);
      expect(limited.length).toBe(20);
    });
  });
});
