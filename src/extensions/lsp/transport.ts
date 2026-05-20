/**
 * JSON-RPC over stdio transport for LSP servers.
 *
 * Handles the LSP wire protocol (Content-Length framing), request/response
 * correlation, and notification dispatch. Has no knowledge of LSP semantics.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string>;
}

export class JsonRpcTransport {
  private readonly process: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<
    string,
    Array<(params: unknown) => void>
  >();
  private alive = true;
  private readBuffer = Buffer.alloc(0);
  private stderrBuffer = "";

  constructor(options: SpawnOptions) {
    this.process = spawn(options.command, options.args as string[], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout!.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.process.stderr!.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString();
    });
    this.process.on("exit", () => this.handleExit());
    this.process.on("error", (err) => this.handleProcessError(err));
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   * Rejects if no response arrives within timeoutMs or the process exits.
   */
  async sendRequest(
    method: string,
    params?: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.alive) {
      throw new Error(`Transport is not alive (method: ${method})`);
    }

    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(message);
    });
  }

  /**
   * Send a JSON-RPC notification. No response is expected.
   */
  sendNotification(method: string, params?: unknown): void {
    if (!this.alive) return;
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  /**
   * Register a handler for incoming notifications by method name.
   * Multiple handlers per method are supported and all are called.
   */
  onNotification(method: string, handler: (params: unknown) => void): void {
    const existing = this.notificationHandlers.get(method);
    if (existing) {
      existing.push(handler);
    } else {
      this.notificationHandlers.set(method, [handler]);
    }
  }

  /**
   * Kill the child process and reject all pending requests.
   * SIGTERM first, then SIGKILL after 2 seconds if still alive.
   */
  dispose(): void {
    if (!this.alive) return;
    this.alive = false;

    this.rejectAllPending(new Error("Transport disposed"));
    this.notificationHandlers.clear();

    this.process.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!this.process.killed) this.process.kill("SIGKILL");
    }, 2000);
    // Don't keep the node process alive just for this timer.
    if (killTimer.unref) killTimer.unref();
  }

  /** Whether the child process is still running. */
  get isAlive(): boolean {
    return this.alive;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private writeMessage(message: object): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = `Content-Length: ${body.byteLength}\r\n\r\n`;
    const frame = Buffer.concat([Buffer.from(header, "ascii"), body]);
    this.process.stdin!.write(frame);
  }

  /**
   * Accumulate incoming bytes and extract complete JSON-RPC messages.
   *
   * LSP messages may arrive in arbitrary chunks. We buffer raw bytes,
   * parse the Content-Length header, then wait until we have that many
   * body bytes before attempting JSON.parse. Content-Length counts bytes,
   * not characters, so we operate on Buffers throughout.
   */
  private handleData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

    while (true) {
      // Find header terminator \r\n\r\n
      const headerEnd = this.readBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerStr = this.readBuffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
      if (!match) {
        // Malformed header — discard up to and including the terminator.
        this.readBuffer = this.readBuffer.subarray(headerEnd + 4);
        continue;
      }

      const bodyLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;

      if (this.readBuffer.byteLength < bodyStart + bodyLength) break;

      const body = this.readBuffer.subarray(bodyStart, bodyStart + bodyLength);
      this.readBuffer = this.readBuffer.subarray(bodyStart + bodyLength);

      try {
        const message = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        this.dispatchMessage(message);
      } catch {
        // Unparseable body — skip it; don't crash the transport.
      }
    }
  }

  private dispatchMessage(message: Record<string, unknown>): void {
    if ("id" in message && !("method" in message)) {
      // Response to a prior client request.
      const id = message["id"] as number;
      const pending = this.pending.get(id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(id);

      if (message["error"]) {
        const err = message["error"] as { code: number; message: string };
        pending.reject(
          new Error(`JSON-RPC error ${err.code}: ${err.message}`),
        );
      } else {
        pending.resolve(message["result"]);
      }
    } else if ("id" in message && "method" in message) {
      // Server-initiated request — reply with an error so the server does not stall.
      this.writeMessage({
        jsonrpc: "2.0",
        id: message["id"],
        error: { code: -32601, message: "Method not supported" },
      });
    } else if ("method" in message) {
      // Incoming notification.
      const method = message["method"] as string;
      const handlers = this.notificationHandlers.get(method);
      if (handlers) {
        for (const handler of handlers) {
          handler(message["params"]);
        }
      }
    }
  }

  private handleExit(): void {
    if (!this.alive) return;
    this.alive = false;
    this.rejectAllPending(
      new Error("Language server process exited unexpectedly"),
    );
  }

  private handleProcessError(err: Error): void {
    if (!this.alive) return;
    this.alive = false;
    this.rejectAllPending(
      new Error(`Language server process error: ${err.message}`),
    );
  }

  private rejectAllPending(reason: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
