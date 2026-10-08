// src/api/gatewayClient.ts — app adapter over the vendored JsonRpcGatewayClient
// (spec §4.2, contract §2). One instance per chat screen, reused across reconnects.
import {
  JsonRpcGatewayClient,
  JsonRpcGatewayError,
  type ConnectionState,
  type GatewayEvent,
  type RpcMethods,
  type ServerRequestHandler,
} from '@/vendor/hermes-gateway';

/** A rejected JSON-RPC call, carrying the gateway's numeric error code
 * (e.g. 4009 = session busy, 4001 = stale session) so callers can branch on it
 * without string-matching. -1 = no gateway code (timeout, socket closed, …). */
export class RpcError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = 'RpcError';
  }
}

export class DeliveryUnknownError extends RpcError {
  constructor(message: string) {
    super(message, -1);
    this.name = 'DeliveryUnknownError';
  }
}

export interface GatewayClientDeps {
  /** Today's makeNativeSocket — no Origin header (spec §4.1, review m1). */
  socketFactory: (url: string) => WebSocket;
  /** Per-call timeout; default 120_000 (the vendored default). */
  requestTimeoutMs?: number;
  /** How long connect() waits for `gateway.ready` after open. Default 15_000. */
  readyTimeoutMs?: number;
}

const WS_OPEN = 1;

function toRpcError(e: unknown): RpcError {
  if (e instanceof RpcError) return e;
  if (e instanceof JsonRpcGatewayError) return new RpcError(e.message, e.code ?? -1);
  return new RpcError(e instanceof Error ? e.message : String(e), -1);
}

export class GatewayClient {
  private readonly inner: JsonRpcGatewayClient;
  private socket: WebSocket | null = null;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private readonly readyTimeoutMs: number;

  constructor(deps: GatewayClientDeps) {
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 15_000;
    this.inner = new JsonRpcGatewayClient({
      socketFactory: (url) => (this.socket = deps.socketFactory(url)),
      requestTimeoutMs: deps.requestTimeoutMs ?? 120_000,
      replay: false, // replay is app-orchestrated (spec §7)
    });
    // Registered FIRST, before any app handler: resolves the connect() gate.
    this.inner.on('gateway.ready', () => {
      const w = this.readyWaiter;
      this.readyWaiter = null;
      w?.resolve();
    });
    this.inner.onState((s) => {
      if ((s === 'closed' || s === 'error') && this.readyWaiter) {
        const w = this.readyWaiter;
        this.readyWaiter = null;
        w.reject(new RpcError('socket closed before gateway.ready', -1));
      }
    });
  }

  /** Resolves only after socket open AND `gateway.ready` AND one macrotask tick,
   * so the channel's `client.capabilities` frame is on the wire before the caller
   * sends `session.resume` (review M2). Zombie-safe: drops any current socket first. */
  async connect(url: string): Promise<void> {
    this.inner.invalidate(); // no-op without a socket; drops a zombie/half-open one
    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });
    ready.catch(() => {}); // observed below; avoid an unhandled rejection if connect() throws first
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.inner.connect(url);
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RpcError(`no gateway.ready within ${this.readyTimeoutMs} ms`, -1)),
            this.readyTimeoutMs,
          );
        }),
      ]);
    } catch (e) {
      this.readyWaiter = null;
      this.inner.invalidate();
      throw toRpcError(e);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    await new Promise<void>((r) => setTimeout(r, 0)); // one macrotask: capabilities frame already sent
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  close(): void {
    this.inner.close();
  }

  /** True only while the current socket reads OPEN (a suspended-then-torn-down
   * iOS socket reads CLOSED even though no close event fired). */
  get isOpen(): boolean {
    return this.inner.connectionState === 'open' && this.socket?.readyState === WS_OPEN;
  }

  call<M extends keyof RpcMethods>(
    method: M,
    params: RpcMethods[M]['params'],
  ): Promise<RpcMethods[M]['result']> {
    return this.inner
      .request<RpcMethods[M]['result']>(method, params as unknown as Record<string, unknown>)
      .catch((e: unknown) => {
        throw toRpcError(e);
      });
  }

  onEvent(handler: (event: GatewayEvent) => void): () => void {
    return this.inner.onEvent(handler);
  }

  /** MUST be registered before the first connect() (review M3). */
  onRequest(handler: ServerRequestHandler): () => void {
    return this.inner.onRequest(handler);
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    return this.inner.onState(handler);
  }
}

/** Production socket factory (RN WebSocket). No headers: the gateway accepts
 * `?ticket=` without an Origin check (review m1). */
export function makeNativeSocket(url: string): WebSocket {
  return new WebSocket(url);
}
