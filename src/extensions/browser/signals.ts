/**
 * Console/network/exception signal buffer for the persistent browser page.
 *
 * Accumulates page signals between checks so a single tool result can carry
 * everything that happened since the last look at the page.
 * No imports from the pi extension API package.
 */

// ---------------------------------------------------------------------------
// Buffered signal shapes
// ---------------------------------------------------------------------------

/** A console message of interest (errors and warnings only). */
export interface ConsoleSignal {
  type: "error" | "warning";
  text: string;
}

/** A network request that failed, either at the network level or with an HTTP error status. */
export interface FailedRequest {
  url: string;
  /** HTTP status when the server responded with >= 400. Absent for network-level failures. */
  status?: number;
  /** Network failure text (e.g. "net::ERR_CONNECTION_REFUSED"). Absent for HTTP error responses. */
  failureText?: string;
}

/** An uncaught exception thrown in the page. */
export interface PageException {
  message: string;
  stack?: string;
}

/** Everything accumulated since the last drain. */
export interface PageSignals {
  console: ConsoleSignal[];
  failedRequests: FailedRequest[];
  exceptions: PageException[];
}

// ---------------------------------------------------------------------------
// Event source (structural subset of Playwright's Page)
// ---------------------------------------------------------------------------

/** Structural subset of Playwright's ConsoleMessage. */
export interface ConsoleMessageLike {
  type(): string;
  text(): string;
}

/** Structural subset of Playwright's Request. */
export interface RequestLike {
  url(): string;
  failure(): { errorText: string } | null;
}

/** Structural subset of Playwright's Response. */
export interface ResponseLike {
  url(): string;
  status(): number;
}

/**
 * Structural subset of Playwright's Page event API used by the buffer.
 * A real `Page` satisfies this; tests can pass a plain fake emitter.
 */
export interface PageEventSource {
  on(event: "console", handler: (message: ConsoleMessageLike) => void): unknown;
  on(event: "requestfailed", handler: (request: RequestLike) => void): unknown;
  on(event: "response", handler: (response: ResponseLike) => void): unknown;
  on(event: "pageerror", handler: (error: Error) => void): unknown;
  off(event: "console", handler: (message: ConsoleMessageLike) => void): unknown;
  off(event: "requestfailed", handler: (request: RequestLike) => void): unknown;
  off(event: "response", handler: (response: ResponseLike) => void): unknown;
  off(event: "pageerror", handler: (error: Error) => void): unknown;
}

const HTTP_ERROR_STATUS_MIN = 400;

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

/**
 * Accumulates console errors/warnings, failed network requests, and uncaught
 * page exceptions. `drain()` returns everything buffered since the previous
 * drain and resets the buffer (since-last-check semantics).
 */
export class SignalBuffer {
  private consoleSignals: ConsoleSignal[] = [];
  private failedRequests: FailedRequest[] = [];
  private exceptions: PageException[] = [];
  private source: PageEventSource | null = null;

  private readonly onConsole = (message: ConsoleMessageLike): void => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    this.consoleSignals.push({ type, text: message.text() });
  };

  private readonly onRequestFailed = (request: RequestLike): void => {
    this.failedRequests.push({
      url: request.url(),
      failureText: request.failure()?.errorText ?? "unknown failure",
    });
  };

  private readonly onResponse = (response: ResponseLike): void => {
    if (response.status() < HTTP_ERROR_STATUS_MIN) return;
    this.failedRequests.push({ url: response.url(), status: response.status() });
  };

  private readonly onPageError = (error: Error): void => {
    this.exceptions.push({ message: error.message, stack: error.stack });
  };

  /**
   * Wire listeners onto a page. If already attached to a page, detaches from
   * it first so signals are never double-counted.
   *
   * @param page - The page (or structural equivalent) to observe.
   */
  attach(page: PageEventSource): void {
    if (this.source) this.detach();
    this.source = page;
    page.on("console", this.onConsole);
    page.on("requestfailed", this.onRequestFailed);
    page.on("response", this.onResponse);
    page.on("pageerror", this.onPageError);
  }

  /**
   * Return all signals accumulated since the last drain and clear the buffer.
   *
   * @returns The buffered console messages, failed requests, and exceptions.
   */
  drain(): PageSignals {
    const drained: PageSignals = {
      console: this.consoleSignals,
      failedRequests: this.failedRequests,
      exceptions: this.exceptions,
    };
    this.consoleSignals = [];
    this.failedRequests = [];
    this.exceptions = [];
    return drained;
  }

  /**
   * Remove listeners from the attached page and discard any buffered signals.
   * Safe to call when not attached.
   */
  detach(): void {
    if (this.source) {
      this.source.off("console", this.onConsole);
      this.source.off("requestfailed", this.onRequestFailed);
      this.source.off("response", this.onResponse);
      this.source.off("pageerror", this.onPageError);
      this.source = null;
    }
    this.drain();
  }
}
