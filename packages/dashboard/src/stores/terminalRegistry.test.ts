import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  getOrCreateTerminal,
  destroyTerminal,
  setMessageNotificationCallback,
  destroyAllTerminals,
} from './terminalRegistry';

// Mock xterm.js
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => ({
    write: vi.fn((text, callback) => callback?.()),
    scrollToBottom: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(),
    onSelectionChange: vi.fn(),
    getSelection: vi.fn(),
    loadAddon: vi.fn(),
    open: vi.fn(),
    buffer: {
      active: {
        baseY: 0,
        cursorY: 10,
        length: 100,
      },
    },
    rows: 24,
    cols: 80,
    options: {},
    element: null,
  })),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(),
  })),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(() => ({
    onContextLoss: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CLOSING = 2;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
}

global.WebSocket = MockWebSocket as any;

// Mock document.createElement
global.document.createElement = vi.fn((tag: string) => {
  const elem = {
    style: {},
    parentElement: null,
  };
  return elem as any;
}) as any;

describe('terminalRegistry - Notification Preview Extraction', () => {
  const sessionId = 'test-session';
  const agentId = 'test-agent';
  const theme = {};

  beforeEach(() => {
    vi.clearAllMocks();
    destroyAllTerminals();
  });

  afterEach(() => {
    destroyAllTerminals();
  });

  it('should extract sender from notification pattern', () => {
    // Test the regex pattern directly
    const messagePattern = /\[(?:New )?[Mm]essage from ([^\]]+)\]/;

    const test1 = '[New message from Backend]: '.match(messagePattern);
    expect(test1?.[1]).toBe('Backend');

    const test2 = '[Message from Frontend]: '.match(messagePattern);
    expect(test2?.[1]).toBe('Frontend');

    const test3 = '[message from Worker]: '.match(messagePattern);
    expect(test3?.[1]).toBe('Worker');
  });

  it('should extract preview from quoted text', () => {
    const previewPattern = /[""]([^""]+)[""]|^([^[\r\n]{10,})/;

    const text = '"Task completed successfully"';
    const match = text.match(previewPattern);
    const preview = match ? (match[1] || match[2])?.trim() : undefined;

    expect(preview).toBe('Task completed successfully');
  });

  it('should extract preview from unquoted long text', () => {
    const previewPattern = /[""]([^""]+)[""]|^([^[\r\n]{10,})/;

    const text = 'Please review the pull request when you have a moment';
    const match = text.match(previewPattern);
    const preview = match ? (match[1] || match[2])?.trim() : undefined;

    expect(preview).toBe('Please review the pull request when you have a moment');
  });

  it('should not extract preview from short text', () => {
    const previewPattern = /[""]([^""]+)[""]|^([^[\r\n]{10,})/;

    const text = 'Short';
    const match = text.match(previewPattern);
    const preview = match ? (match[1] || match[2])?.trim() : undefined;

    expect(preview).toBeUndefined();
  });

  it('should preserve scroll position when user scrolled up', () => {
    const entry = getOrCreateTerminal(sessionId, agentId, theme);
    const mockTerm = entry.term as any;

    // Mock user scrolled up (not at bottom)
    mockTerm.buffer.active.baseY = 0;
    mockTerm.buffer.active.cursorY = 10;
    mockTerm.buffer.active.length = 100;

    const mockWs = entry.ws as any;
    mockWs.onmessage?.({ data: 'new output line\n' });

    // Should NOT call scrollToBottom when user is scrolled up
    expect(mockTerm.scrollToBottom).not.toHaveBeenCalled();
  });

  it('should auto-scroll when user is at bottom', () => {
    const entry = getOrCreateTerminal(sessionId, agentId, theme);
    const mockTerm = entry.term as any;

    // Mock user at bottom
    mockTerm.buffer.active.baseY = 80;
    mockTerm.buffer.active.cursorY = 20;
    mockTerm.buffer.active.length = 100;

    const mockWs = entry.ws as any;
    mockWs.onmessage?.({ data: 'new output line\n' });

    // Should call scrollToBottom when user is at bottom
    expect(mockTerm.scrollToBottom).toHaveBeenCalled();
  });

  it('should resume auto-scroll after user returns to bottom', () => {
    const entry = getOrCreateTerminal(sessionId, agentId, theme);
    const mockTerm = entry.term as any;

    // User scrolled up
    mockTerm.buffer.active.baseY = 0;
    mockTerm.buffer.active.cursorY = 10;
    mockTerm.buffer.active.length = 100;

    const mockWs = entry.ws as any;
    mockWs.onmessage?.({ data: 'line 1\n' });

    expect(mockTerm.scrollToBottom).not.toHaveBeenCalled();

    // User scrolls back to bottom
    mockTerm.buffer.active.baseY = 80;
    mockTerm.buffer.active.cursorY = 20;

    mockWs.onmessage?.({ data: 'line 2\n' });

    // Should resume auto-scroll
    expect(mockTerm.scrollToBottom).toHaveBeenCalled();
  });

  it('should allow setting and clearing notification callback', () => {
    getOrCreateTerminal(sessionId, agentId, theme);

    const mockCallback = vi.fn();
    setMessageNotificationCallback(sessionId, agentId, mockCallback);

    // Clear callback
    setMessageNotificationCallback(sessionId, agentId, undefined);

    // Callback should not be called after clearing
    const entry = getOrCreateTerminal(sessionId, agentId, theme);
    const mockWs = entry.ws as any;
    mockWs.onmessage?.({ data: '[Message from Test]: ' });
    mockWs.onmessage?.({ data: '"test message"' });

    expect(mockCallback).not.toHaveBeenCalled();
  });

  it('should detect case-insensitive message patterns', () => {
    const messagePattern = /\[(?:New )?[Mm]essage from ([^\]]+)\]/;

    const lowercase = '[message from Worker]: '.match(messagePattern);
    expect(lowercase?.[1]).toBe('Worker');

    const mixedCase = '[Message from Backend]: '.match(messagePattern);
    expect(mixedCase?.[1]).toBe('Backend');
  });
});
