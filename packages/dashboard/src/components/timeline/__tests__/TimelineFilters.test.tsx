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

    // Use getAllBy* to handle React 19 double-render in happy-dom
    expect(screen.getAllByTestId('segmented-control').length).toBeGreaterThanOrEqual(2); // Category + Density
    expect(screen.getAllByTestId('multi-select').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('text-input').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('switch').length).toBeGreaterThanOrEqual(1);
  });

  it('should call onFilterChange when category filter changes', () => {
    const onFilterChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onFilterChange={onFilterChange} />);

    const agentsButtons = screen.getAllByText('Agents');
    fireEvent.click(agentsButtons[0]);

    expect(onFilterChange).toHaveBeenCalledWith('agents');
  });

  it('should call onDensityChange when density changes', () => {
    const onDensityChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onDensityChange={onDensityChange} />);

    const compactButtons = screen.getAllByText('Compact');
    fireEvent.click(compactButtons[0]);

    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('should call onSearchChange when search input changes', () => {
    const onSearchChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onSearchChange={onSearchChange} />);

    const searchInputs = screen.getAllByTestId('text-input');
    fireEvent.change(searchInputs[0], { target: { value: 'test query' } });

    expect(onSearchChange).toHaveBeenCalled();
  });

  it('should call onAgentFilterChange when agent selection changes', () => {
    const onAgentFilterChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onAgentFilterChange={onAgentFilterChange} />);

    const agentSelects = screen.getAllByTestId('multi-select');
    fireEvent.change(agentSelects[0], {
      target: { selectedOptions: [{ value: 'agent-1' }, { value: 'agent-2' }] },
    });

    expect(onAgentFilterChange).toHaveBeenCalled();
  });

  it('should call onLiveModeChange when live mode switch toggles', () => {
    const onLiveModeChange = vi.fn();
    render(<TimelineFilters {...defaultProps} onLiveModeChange={onLiveModeChange} />);

    const liveSwitches = screen.getAllByTestId('switch');
    fireEvent.change(liveSwitches[0], { target: { checked: false } });

    expect(onLiveModeChange).toHaveBeenCalled();
  });

  it('should render MultiSelect with all agents', () => {
    render(<TimelineFilters {...defaultProps} />);

    expect(screen.getAllByText('Frontend').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Backend').length).toBeGreaterThanOrEqual(1);
  });

  it('should show search placeholder', () => {
    render(<TimelineFilters {...defaultProps} />);

    const searchInputs = screen.getAllByPlaceholderText('Search events...');
    expect(searchInputs.length).toBeGreaterThanOrEqual(1);
  });

  it('should show live mode switch in checked state', () => {
    render(<TimelineFilters {...defaultProps} liveMode={true} />);

    const liveSwitches = screen.getAllByTestId('switch') as HTMLInputElement[];
    expect(liveSwitches[0].checked).toBe(true);
  });

  it('should handle empty agent list', () => {
    render(<TimelineFilters {...defaultProps} agents={[]} />);

    // MultiSelect should not be rendered when no agents
    const multiSelects = screen.queryAllByTestId('multi-select');
    expect(multiSelects.length).toBe(0);
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

    expect(screen.getAllByText('All').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Agents').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Messages').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Tasks').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('System').length).toBeGreaterThanOrEqual(1);
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

    expect(screen.getAllByText('Compact').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Normal').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Detailed').length).toBeGreaterThanOrEqual(1);
  });
});
