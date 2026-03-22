// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
expect.extend(matchers);
import { render, screen, fireEvent } from '@testing-library/react';
import { TimelineFilters } from '../TimelineFilters';

// Mock Mantine components
vi.mock('@mantine/core', () => ({
  SegmentedControl: ({ value, onChange, data }: any) => (
    <div data-testid="segmented-control">
      {data.map((item: any) => (
        <button key={item.value} onClick={() => onChange(item.value)} data-selected={value === item.value}>
          {item.label}
        </button>
      ))}
    </div>
  ),
  TextInput: ({ value, onChange, placeholder }: any) => (
    <input
      data-testid="text-input"
      placeholder={placeholder}
      value={value}
      onChange={onChange}
    />
  ),
  MultiSelect: ({ value, onChange, data, placeholder }: any) => (
    <select
      data-testid="multi-select"
      multiple
      value={value}
      onChange={(e) => {
        const selected = Array.from(e.target.selectedOptions).map((opt: any) => opt.value);
        onChange(selected);
      }}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {data?.map((item: any) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
  Switch: ({ checked, onChange, label }: any) => (
    <label>
      <input
        data-testid="switch"
        type="checkbox"
        checked={checked}
        onChange={onChange}
      />
      {label}
    </label>
  ),
  Group: ({ children }: any) => <div data-testid="group">{children}</div>,
}));

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

  it('should render all filter controls', () => {
    render(<TimelineFilters {...defaultProps} />);

    expect(screen.getAllByTestId('segmented-control')).toHaveLength(2); // Category + Density
    expect(screen.getByTestId('multi-select')).toBeInTheDocument();
    expect(screen.getByTestId('text-input')).toBeInTheDocument();
    expect(screen.getByTestId('switch')).toBeInTheDocument();
  });

  it('should call onFilterChange when category filter changes', () => {
    const onFilterChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onFilterChange={onFilterChange} />);

    const agentsButton = screen.getByText('Agents');
    fireEvent.click(agentsButton);

    expect(onFilterChange).toHaveBeenCalledWith('agents');
  });

  it('should call onDensityChange when density changes', () => {
    const onDensityChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onDensityChange={onDensityChange} />);

    const compactButton = screen.getByText('Compact');
    fireEvent.click(compactButton);

    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('should call onSearchChange when search input changes', () => {
    const onSearchChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onSearchChange={onSearchChange} />);

    const searchInput = screen.getByTestId('text-input');
    fireEvent.change(searchInput, { target: { value: 'test query' } });

    expect(onSearchChange).toHaveBeenCalled();
  });

  it('should call onAgentFilterChange when agent selection changes', () => {
    const onAgentFilterChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onAgentFilterChange={onAgentFilterChange} />);

    const agentSelect = screen.getByTestId('multi-select');
    fireEvent.change(agentSelect, {
      target: { selectedOptions: [{ value: 'agent-1' }, { value: 'agent-2' }] },
    });

    expect(onAgentFilterChange).toHaveBeenCalled();
  });

  it('should call onLiveModeChange when live mode switch toggles', () => {
    const onLiveModeChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onLiveModeChange={onLiveModeChange} />);

    const liveSwitch = screen.getByTestId('switch');
    fireEvent.change(liveSwitch, { target: { checked: false } });

    expect(onLiveModeChange).toHaveBeenCalled();
  });

  it('should render MultiSelect with all agents', () => {
    render(<TimelineFilters {...defaultProps} />);

    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
  });

  it('should show search placeholder', () => {
    render(<TimelineFilters {...defaultProps} />);

    const searchInput = screen.getByPlaceholderText('Search events...');
    expect(searchInput).toBeInTheDocument();
  });

  it('should show live mode switch in checked state', () => {
    render(<TimelineFilters {...defaultProps} liveMode={true} />);

    const liveSwitch = screen.getByTestId('switch') as HTMLInputElement;
    expect(liveSwitch.checked).toBe(true);
  });

  it('should handle empty agent list', () => {
    render(<TimelineFilters {...defaultProps} agents={[]} />);

    // MultiSelect should not be rendered when no agents
    expect(screen.queryByTestId('multi-select')).not.toBeInTheDocument();
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
    render(<TimelineFilters {...defaultProps} />);

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
    render(<TimelineFilters {...defaultProps} />);

    expect(screen.getByText('Compact')).toBeInTheDocument();
    expect(screen.getByText('Normal')).toBeInTheDocument();
    expect(screen.getByText('Detailed')).toBeInTheDocument();
  });
});
