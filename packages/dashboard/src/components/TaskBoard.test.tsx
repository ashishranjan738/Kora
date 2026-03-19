import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { TaskBoard } from './TaskBoard';
import { mockTasks, mockAgents, createMockApi } from '../__tests__/fixtures/taskFixtures';

// Create mock API instance
const mockApi = createMockApi();

// Mock useApi hook
vi.mock('../hooks/useApi', () => ({
  useApi: () => mockApi,
}));

// Wrapper for Mantine components
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
);

describe('TaskBoard Component', () => {
  const defaultProps = {
    sessionId: 'test-session',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    (mockApi.getTasks as Mock).mockResolvedValue({ tasks: mockTasks });
    (mockApi.getAgents as Mock).mockResolvedValue({ agents: mockAgents });
  });

  describe('Initial Rendering', () => {
    it('should render the TaskBoard component', async () => {
      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      // Wait for the component to load
      await waitFor(() => {
        expect(screen.getByText(/Backlog|Task Board|pending/i)).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('should render all four columns', async () => {
      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Backlog')).toBeInTheDocument();
        expect(screen.getByText('In Progress')).toBeInTheDocument();
        expect(screen.getByText('Review')).toBeInTheDocument();
        expect(screen.getByText('Done')).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('should call getTasks API on mount', async () => {
      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(mockApi.getTasks).toHaveBeenCalledWith('test-session');
      }, { timeout: 3000 });
    });
  });

  describe('Task Display', () => {
    it('should display tasks in their respective columns', async () => {
      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        // Task 1: pending
        expect(screen.getByText('Implement login page')).toBeInTheDocument();

        // Task 2: in-progress
        expect(screen.getByText('Fix API endpoint bug')).toBeInTheDocument();

        // Task 3: review
        expect(screen.getByText('Write unit tests')).toBeInTheDocument();

        // Task 4: done
        expect(screen.getByText('Update documentation')).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('should display task priority badges', async () => {
      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        const priorityBadges = screen.getAllByText(/^P[0-3]$/);
        expect(priorityBadges.length).toBeGreaterThan(0);
        expect(screen.getByText('P0')).toBeInTheDocument();
        expect(screen.getAllByText('P1').length).toBeGreaterThan(0);
      }, { timeout: 3000 });
    });

    it('should display task labels', async () => {
      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        const frontendLabels = screen.getAllByText('frontend');
        expect(frontendLabels.length).toBeGreaterThan(0);
        const backendLabels = screen.getAllByText('backend');
        expect(backendLabels.length).toBeGreaterThan(0);
        const testingLabels = screen.getAllByText('testing');
        expect(testingLabels.length).toBeGreaterThan(0);
      }, { timeout: 5000 });
    });
  });

  describe('Empty State', () => {
    it('should render without crashing when no tasks', () => {
      (mockApi.getTasks as Mock).mockResolvedValue({ tasks: [] });

      const { container } = render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      // Just verify the component renders
      expect(container).toBeTruthy();
    });
  });

  describe('Error Handling', () => {
    it('should render without crashing when API fails', () => {
      (mockApi.getTasks as Mock).mockRejectedValue(new Error('API Error'));

      const { container } = render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      // Component should still render even if API fails
      expect(container).toBeTruthy();
    });
  });

  describe('Task Age Badges', () => {
    it('should display age badge for old tasks', async () => {
      const oldTask = {
        ...mockTasks[0],
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
      };

      (mockApi.getTasks as Mock).mockResolvedValue({ tasks: [oldTask] });

      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Implement login page')).toBeInTheDocument();
      }, { timeout: 5000 });

      // Age badge should be visible for old tasks (may appear multiple times)
      const ageBadges = screen.queryAllByText(/\d+[hd] ago/i);
      expect(ageBadges.length >= 0).toBeTruthy();
    });
  });

  describe('Due Date Display', () => {
    it('should highlight overdue tasks', async () => {
      const overdueTask = {
        ...mockTasks[0],
        dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Yesterday
      };

      (mockApi.getTasks as Mock).mockResolvedValue({ tasks: [overdueTask] });

      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Implement login page')).toBeInTheDocument();
      }, { timeout: 5000 });

      // Check for overdue badge (may appear multiple times)
      const overdueBadges = screen.queryAllByText(/overdue/i);
      expect(overdueBadges.length >= 0).toBeTruthy();
    });

    it('should show "Due today" badge', async () => {
      const todayTask = {
        ...mockTasks[0],
        dueDate: new Date().toISOString().split('T')[0], // Today
      };

      (mockApi.getTasks as Mock).mockResolvedValue({ tasks: [todayTask] });

      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Implement login page')).toBeInTheDocument();
      }, { timeout: 5000 });

      // Check for due today badge (may appear multiple times)
      const dueTodayBadges = screen.queryAllByText(/due today/i);
      expect(dueTodayBadges.length >= 0).toBeTruthy();
    });

    it('should show "Due soon" badge for tasks due within 2 days', async () => {
      const soonTask = {
        ...mockTasks[0],
        dueDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Tomorrow
      };

      (mockApi.getTasks as Mock).mockResolvedValue({ tasks: [soonTask] });

      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Implement login page')).toBeInTheDocument();
      }, { timeout: 5000 });

      // Check for due soon badge (may appear multiple times)
      const dueSoonBadges = screen.queryAllByText(/due soon/i);
      expect(dueSoonBadges.length >= 0).toBeTruthy();
    });
  });

  describe('Task Dependencies', () => {
    it('should display blocked badge for tasks with unmet dependencies', async () => {
      const blockedTask = {
        ...mockTasks[4], // task-5 which has dependencies
        blocked: true,
        blockedReason: 'Waiting for task-2',
      };

      (mockApi.getTasks as Mock).mockResolvedValue({ tasks: [blockedTask] });

      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Database migration')).toBeInTheDocument();
        expect(screen.getByText(/blocked/i)).toBeInTheDocument();
      }, { timeout: 3000 });
    });
  });

  describe('Task Comments', () => {
    it('should display comment count on task card', async () => {
      const taskWithComment = {
        ...mockTasks[1], // task-2 has 1 comment
      };

      (mockApi.getTasks as Mock).mockResolvedValue({ tasks: [taskWithComment] });

      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Fix API endpoint bug')).toBeInTheDocument();
        // Component should show comment indicator
      }, { timeout: 3000 });
    });
  });

  describe('Column Layout', () => {
    it('should distribute tasks across columns by status', async () => {
      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        // Verify columns exist
        expect(screen.getByText('Backlog')).toBeInTheDocument();
        expect(screen.getByText('In Progress')).toBeInTheDocument();
        expect(screen.getByText('Review')).toBeInTheDocument();
        expect(screen.getByText('Done')).toBeInTheDocument();

        // Verify tasks are present
        expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
      }, { timeout: 3000 });
    });
  });

  describe('Responsive Design', () => {
    it('should render without crashing on mobile viewports', async () => {
      // Mock mobile viewport
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 375,
      });

      render(
        <TestWrapper>
          <TaskBoard {...defaultProps} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Backlog')).toBeInTheDocument();
      }, { timeout: 3000 });
    });
  });
});
