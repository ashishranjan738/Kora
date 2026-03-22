// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebounce } from '../useDebounce';

describe('useDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('initial', 300));

    expect(result.current).toBe('initial');
  });

  it('should debounce value changes by 300ms', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 'initial' },
    });

    expect(result.current).toBe('initial');

    rerender({ value: 'updated' });
    expect(result.current).toBe('initial');

    act(() => { vi.advanceTimersByTime(300); });

    expect(result.current).toBe('updated');
  });

  it('should reset timer on rapid changes', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 'initial' },
    });

    rerender({ value: 'change1' });
    act(() => { vi.advanceTimersByTime(100); });

    rerender({ value: 'change2' });
    act(() => { vi.advanceTimersByTime(100); });

    rerender({ value: 'change3' });
    act(() => { vi.advanceTimersByTime(100); });

    // Timer keeps resetting — value should still be initial
    expect(result.current).toBe('initial');

    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current).toBe('change3');
  });

  it('should support custom delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
      initialProps: { value: 'initial' },
    });

    rerender({ value: 'updated' });

    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current).toBe('initial');

    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toBe('updated');
  });

  it('should handle empty string', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 'text' },
    });

    rerender({ value: '' });

    act(() => { vi.advanceTimersByTime(300); });

    expect(result.current).toBe('');
  });

  it('should handle number values', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 0 },
    });

    rerender({ value: 42 });

    act(() => { vi.advanceTimersByTime(300); });

    expect(result.current).toBe(42);
  });

  it('should handle object values', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: { id: 1 } },
    });

    const newObj = { id: 2 };
    rerender({ value: newObj });

    act(() => { vi.advanceTimersByTime(300); });

    expect(result.current).toEqual(newObj);
  });

  it('should cleanup timer on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    const { unmount } = renderHook(() => useDebounce('value', 300));

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
