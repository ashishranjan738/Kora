import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimelineEvent } from '../TimelineEvent';
import type { TimelineEventData } from '../TimelineEvent';

// Mock Mantine components
vi.mock('@mantine/core', () => ({
  Badge: ({ children }: any) => <span data-testid="badge">{children}</span>,
  ActionIcon: ({ children, onClick }: any) => (
    <button data-testid="action-icon" onClick={onClick}>
      {children}
    </button>
  ),
  Tooltip: ({ children }: any) => <div>{children}</div>,
}));

describe('TimelineEvent - Event Type Rendering', () => {
  const defaultProps = {
    density: 'normal' as const,
  };

  it('should render agent-spawned event', () => {
    const event: TimelineEventData = {
      id: 'evt-1',
      type: 'agent-spawned',
      timestamp: new Date().toISOString(),
      data: { agentId: 'agent-1', name: 'Frontend', provider: 'claude', model: 'sonnet' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Frontend spawned/)).toBeInTheDocument();
  });

  it('should render agent-status-changed event', () => {
    const event: TimelineEventData = {
      id: 'evt-2',
      type: 'agent-status-changed',
      timestamp: new Date().toISOString(),
      data: { agentId: 'agent-1', name: 'Frontend', newStatus: 'idle' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Frontend → idle/)).toBeInTheDocument();
  });

  it('should render message-sent event', () => {
    const event: TimelineEventData = {
      id: 'evt-3',
      type: 'message-sent',
      timestamp: new Date().toISOString(),
      data: { from: 'agent-1', fromName: 'Frontend', to: 'agent-2', toName: 'Backend' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Frontend → Backend/)).toBeInTheDocument();
  });

  it('should render message-received event', () => {
    const event: TimelineEventData = {
      id: 'evt-4',
      type: 'message-received',
      timestamp: new Date().toISOString(),
      data: { from: 'agent-2', fromName: 'Backend', to: 'agent-1', toName: 'Frontend' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Backend → Frontend/)).toBeInTheDocument();
  });

  it('should render user-interaction event', () => {
    const event: TimelineEventData = {
      id: 'evt-5',
      type: 'user-interaction',
      timestamp: new Date().toISOString(),
      data: { agentId: 'agent-1', agentName: 'Frontend' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/User → Frontend/)).toBeInTheDocument();
  });

  it('should render cost-threshold-reached event', () => {
    const event: TimelineEventData = {
      id: 'evt-6',
      type: 'cost-threshold-reached',
      timestamp: new Date().toISOString(),
      data: { amount: '10.50' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Cost alert: \$10.50/)).toBeInTheDocument();
  });

  it('should render task-created event', () => {
    const event: TimelineEventData = {
      id: 'evt-7',
      type: 'task-created',
      timestamp: new Date().toISOString(),
      data: { title: 'Fix bug in login', taskId: 'task-1' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Task: "Fix bug in login"/)).toBeInTheDocument();
  });

  it('should render session-created event', () => {
    const event: TimelineEventData = {
      id: 'evt-8',
      type: 'session-created',
      timestamp: new Date().toISOString(),
      data: { name: 'My Session' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Session "My Session" created/)).toBeInTheDocument();
  });
});

describe('TimelineEvent - Density Modes', () => {
  const event: TimelineEventData = {
    id: 'evt-1',
    type: 'message-sent',
    timestamp: new Date().toISOString(),
    data: {
      from: 'agent-1',
      fromName: 'Frontend',
      to: 'agent-2',
      toName: 'Backend',
      content: 'Test message content',
    },
  };

  it('should render compact mode', () => {
    const { container } = render(<TimelineEvent event={event} density="compact" />);

    // In compact mode, message content should not be rendered
    expect(screen.queryByText('Test message content')).not.toBeInTheDocument();
  });

  it('should render normal mode with message preview', () => {
    render(<TimelineEvent event={event} density="normal" />);

    // In normal mode, message content should be rendered
    expect(screen.getByText('Test message content')).toBeInTheDocument();
  });

  it('should render detailed mode with full content', () => {
    render(<TimelineEvent event={event} density="detailed" />);

    // In detailed mode, message content should be fully visible
    expect(screen.getByText('Test message content')).toBeInTheDocument();
  });
});

describe('TimelineEvent - Action Buttons', () => {
  const defaultProps = {
    density: 'normal' as const,
    onJumpToTerminal: vi.fn(),
    onRestart: vi.fn(),
    onJumpToTaskBoard: vi.fn(),
  };

  it('should show jump to terminal button for agent-spawned', () => {
    const event: TimelineEventData = {
      id: 'evt-1',
      type: 'agent-spawned',
      timestamp: new Date().toISOString(),
      data: { agentId: 'agent-1', name: 'Frontend' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Terminal/)).toBeInTheDocument();
  });

  it('should show restart button for agent-crashed', () => {
    const event: TimelineEventData = {
      id: 'evt-2',
      type: 'agent-crashed',
      timestamp: new Date().toISOString(),
      data: { agentId: 'agent-1', name: 'Frontend', exitCode: '1' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText('Restart')).toBeInTheDocument();
  });

  it('should show task board button for task events', () => {
    const event: TimelineEventData = {
      id: 'evt-3',
      type: 'task-created',
      timestamp: new Date().toISOString(),
      data: { title: 'Test task', taskId: 'task-1' },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText(/Task Board/)).toBeInTheDocument();
  });

  it('should call onJumpToTerminal when terminal button clicked', () => {
    const onJumpToTerminal = vi.fn();
    const event: TimelineEventData = {
      id: 'evt-1',
      type: 'agent-spawned',
      timestamp: new Date().toISOString(),
      data: { agentId: 'agent-1', name: 'Frontend' },
    };

    render(<TimelineEvent event={event} {...defaultProps} onJumpToTerminal={onJumpToTerminal} />);

    const button = screen.getByText(/Terminal/).closest('button');
    button?.click();

    expect(onJumpToTerminal).toHaveBeenCalledWith('agent-1');
  });
});

describe('TimelineEvent - Message Content', () => {
  const defaultProps = {
    density: 'normal' as const,
  };

  it('should display message content for message-sent', () => {
    const event: TimelineEventData = {
      id: 'evt-1',
      type: 'message-sent',
      timestamp: new Date().toISOString(),
      data: {
        from: 'agent-1',
        to: 'agent-2',
        content: 'Please review the code',
      },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText('Please review the code')).toBeInTheDocument();
  });

  it('should display message content for user-interaction', () => {
    const event: TimelineEventData = {
      id: 'evt-2',
      type: 'user-interaction',
      timestamp: new Date().toISOString(),
      data: {
        agentId: 'agent-1',
        content: 'Fix the login bug',
      },
    };

    render(<TimelineEvent event={event} {...defaultProps} />);

    expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
  });

  it('should handle missing message content gracefully', () => {
    const event: TimelineEventData = {
      id: 'evt-3',
      type: 'message-sent',
      timestamp: new Date().toISOString(),
      data: {
        from: 'agent-1',
        to: 'agent-2',
      },
    };

    const { container } = render(<TimelineEvent event={event} {...defaultProps} />);

    // Should not crash, should render event header
    expect(container).toBeInTheDocument();
  });
});
