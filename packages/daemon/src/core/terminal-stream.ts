import { WebSocket } from "ws";
import { TERMINAL_RING_BUFFER_LINES, MAX_TERMINAL_CONNECTIONS_PER_AGENT } from "@kora/shared";
import fs from "fs";
import path from "path";

/** Simple ring buffer for terminal lines */
class RingBuffer {
  private buffer: string[] = [];
  private maxLines: number;

  constructor(maxLines: number = TERMINAL_RING_BUFFER_LINES) { this.maxLines = maxLines; }

  push(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.maxLines) this.buffer.shift();
  }

  getAll(): string { return this.buffer.join("\n"); }

  clear(): void { this.buffer = []; }
}

export class TerminalStream {
  private clients = new Set<WebSocket>();
  private buffer = new RingBuffer();
  private watcher: fs.FSWatcher | null = null;
  private readPosition = 0;
  private pipeFile: string;

  constructor(
    private agentId: string,
    pipeDir: string, // directory to store the pipe file
  ) {
    this.pipeFile = path.join(pipeDir, `${agentId}.pipe`);
  }

  get clientCount(): number { return this.clients.size; }

  /** Start reading from the pipe file */
  async startReading(): Promise<void> {
    // Create the pipe file if it doesn't exist
    // Start fs.watch on it
    // When it changes, read new bytes from readPosition
    // Split into lines, push to buffer, fan out to clients
  }

  /** Stop reading */
  stopReading(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Add a WebSocket client */
  addClient(ws: WebSocket): boolean {
    if (this.clients.size >= MAX_TERMINAL_CONNECTIONS_PER_AGENT) return false;
    // Send catchup buffer
    ws.send(JSON.stringify({ type: "catchup", data: this.buffer.getAll() }));
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    return true;
  }

  /** Fan out data to all connected clients */
  private fanOut(data: string): void {
    const msg = JSON.stringify({ type: "output", data });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /** Clean up */
  async destroy(): Promise<void> {
    this.stopReading();
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    // Remove pipe file
    try { await fs.promises.unlink(this.pipeFile); } catch {}
  }
}

/** Manages all terminal streams */
export class TerminalStreamManager {
  private streams = new Map<string, TerminalStream>();

  constructor(private pipeDir: string) {}

  /** Create a stream for an agent */
  async createStream(agentId: string): Promise<TerminalStream> {
    const stream = new TerminalStream(agentId, this.pipeDir);
    await stream.startReading();
    this.streams.set(agentId, stream);
    return stream;
  }

  /** Get stream for an agent */
  getStream(agentId: string): TerminalStream | undefined { return this.streams.get(agentId); }

  /** Remove stream */
  async removeStream(agentId: string): Promise<void> {
    const stream = this.streams.get(agentId);
    if (stream) { await stream.destroy(); this.streams.delete(agentId); }
  }

  /** Clean up all */
  async destroyAll(): Promise<void> {
    for (const [id] of this.streams) await this.removeStream(id);
  }
}
