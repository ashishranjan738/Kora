// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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

  it('should debounce value changes by 300ms', async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 'initial' },
    });

    // Initial value
    expect(result.current).toBe('initial');

    // Change value
    rerender({ value: 'updated' });

    // Value should still be initial (not debounced yet)
    expect(result.current).toBe('initial');

    // Fast-forward time by 300ms
    vi.advanceTimersByTime(300);

    // Value should now be updated
    await waitFor(() => {
      expect(result.current).toBe('updated');
    });
  });

  it('should reset timer on rapid changes', async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 'initial' },
    });

    // Change value multiple times rapidly
    rerender({ value: 'change1' });
    vi.advanceTimersByTime(100);

    rerender({ value: 'change2' });
    vi.advanceTimersByTime(100);

    rerender({ value: 'change3' });
    vi.advanceTimersByTime(100);

    // Value should still be initial (timer keeps resetting)
    expect(result.current).toBe('initial');

    // Advance past the debounce delay
    vi.advanceTimersByTime(200);

    // Now it should have the latest value
    await waitFor(() => {
      expect(result.current).toBe('change3');
    });
  });

  it('should support custom delay', async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
      initialProps: { value: 'initial' },
    });

    rerender({ value: 'updated' });

    // After 300ms, should still be initial
    vi.advanceTimersByTime(300);
    expect(result.current).toBe('initial');

    // After 500ms, should be updated
    vi.advanceTimersByTime(200);
    await waitFor(() => {
      expect(result.current).toBe('updated');
    });
  });

  it('should handle empty string', async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 'text' },
    });

    rerender({ value: '' });

    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(result.current).toBe('');
    });
  });

  it('should handle number values', async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: 0 },
    });

    rerender({ value: 42 });

    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(result.current).toBe(42);
    });
  });

  it('should handle object values', async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
      initialProps: { value: { id: 1 } },
    });

    const newObj = { id: 2 };
    rerender({ value: newObj });

    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(result.current).toEqual(newObj);
    });
  });

  it('should cleanup timer on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    const { unmount } = renderHook(() => useDebounce('value', 300));

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
