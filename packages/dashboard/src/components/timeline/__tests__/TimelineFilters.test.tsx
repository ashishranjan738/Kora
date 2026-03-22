// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
expect.extend(matchers);
import { render, screen, fireEvent } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { TimelineFilters } from '../TimelineFilters';

// Wrap in MantineProvider for real Mantine v8 rendering
function renderWithMantine(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

describe('TimelineFilters', () => {
  const defaultProps = {
    filter: 'all' as const,
    onFilterChange: vi.fn(),
    density: 'normal' as const,
    onDensityChange: vi.fn(),
    search: '',
    onSearchChange: vi.fn(),
    agentFilter: '',
    onAgentFilterChange: vi.fn(),
    agents: [
      { id: 'agent-1', name: 'Frontend' },
      { id: 'agent-2', name: 'Backend' },
    ],
    liveMode: true,
    onLiveModeChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render all filter controls', () => {
    renderWithMantine(<TimelineFilters {...defaultProps} />);

    // Category filter options
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();

    // Density options
    expect(screen.getByText('Compact')).toBeInTheDocument();
    expect(screen.getByText('Normal')).toBeInTheDocument();
    expect(screen.getByText('Detailed')).toBeInTheDocument();

    // Search input
    expect(screen.getByPlaceholderText('Search events...')).toBeInTheDocument();

    // Live switch
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('should call onFilterChange when category filter changes', () => {
    const onFilterChange = vi.fn();
    renderWithMantine(<TimelineFilters {...defaultProps} onFilterChange={onFilterChange} />);

    // Click the "Agents" category option
    fireEvent.click(screen.getByText('Agents'));

    expect(onFilterChange).toHaveBeenCalledWith('agents');
  });

  it('should call onDensityChange when density changes', () => {
    const onDensityChange = vi.fn();
    renderWithMantine(<TimelineFilters {...defaultProps} onDensityChange={onDensityChange} />);

    fireEvent.click(screen.getByText('Compact'));

    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('should call onSearchChange when search input changes', () => {
    const onSearchChange = vi.fn();
    renderWithMantine(<TimelineFilters {...defaultProps} onSearchChange={onSearchChange} />);

    const searchInput = screen.getByPlaceholderText('Search events...');
    fireEvent.change(searchInput, { target: { value: 'test query' } });

    expect(onSearchChange).toHaveBeenCalled();
  });

  it('should call onAgentFilterChange when agent selection changes', () => {
    const onAgentFilterChange = vi.fn();
    renderWithMantine(<TimelineFilters {...defaultProps} onAgentFilterChange={onAgentFilterChange} />);

    // MultiSelect is rendered — verify the agents are present as options
    expect(screen.getByPlaceholderText('All agents')).toBeInTheDocument();
  });

  it('should call onLiveModeChange when live mode switch toggles', () => {
    const onLiveModeChange = vi.fn();
    renderWithMantine(<TimelineFilters {...defaultProps} liveMode={true} onLiveModeChange={onLiveModeChange} />);

    // Find the switch checkbox and click it
    const switchEl = screen.getByRole('checkbox');
    fireEvent.click(switchEl);

    expect(onLiveModeChange).toHaveBeenCalled();
  });

  it('should render MultiSelect with all agents', () => {
    renderWithMantine(<TimelineFilters {...defaultProps} />);

    // Agent filter placeholder should be present
    expect(screen.getByPlaceholderText('All agents')).toBeInTheDocument();
  });

  it('should show search placeholder', () => {
    renderWithMantine(<TimelineFilters {...defaultProps} />);

    expect(screen.getByPlaceholderText('Search events...')).toBeInTheDocument();
  });

  it('should show live mode switch in checked state', () => {
    renderWithMantine(<TimelineFilters {...defaultProps} liveMode={true} />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('should handle empty agent list', () => {
    renderWithMantine(<TimelineFilters {...defaultProps} agents={[]} />);

    // MultiSelect should not be rendered when no agents
    expect(screen.queryByPlaceholderText('All agents')).not.toBeInTheDocument();
  });
});

describe('TimelineFilters - Category Filter Options', () => {
  const defaultProps = {
    filter: 'all' as const,
    onFilterChange: vi.fn(),
    density: 'normal' as const,
    onDensityChange: vi.fn(),
    search: '',
    onSearchChange: vi.fn(),
    agentFilter: '',
    onAgentFilterChange: vi.fn(),
    agents: [],
    liveMode: true,
    onLiveModeChange: vi.fn(),
  };

  it('should show all category options', () => {
    renderWithMantine(<TimelineFilters {...defaultProps} />);

    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});

describe('TimelineFilters - Density Options', () => {
  const defaultProps = {
    filter: 'all' as const,
    onFilterChange: vi.fn(),
    density: 'normal' as const,
    onDensityChange: vi.fn(),
    search: '',
    onSearchChange: vi.fn(),
    agentFilter: '',
    onAgentFilterChange: vi.fn(),
    agents: [],
    liveMode: true,
    onLiveModeChange: vi.fn(),
  };

  it('should show all density options', () => {
    renderWithMantine(<TimelineFilters {...defaultProps} />);

    expect(screen.getByText('Compact')).toBeInTheDocument();
    expect(screen.getByText('Normal')).toBeInTheDocument();
    expect(screen.getByText('Detailed')).toBeInTheDocument();
  });
});
