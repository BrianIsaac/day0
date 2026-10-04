/** Types for `slack-socket/bridge.js`, for the TypeScript tests that drive it. */

export declare const SYNC_INTERVAL_MS: number;
export declare const RECONNECT_FIRST_MS: number;
export declare const RECONNECT_CAP_MS: number;
export declare const PRESS_ATTEMPTS: number;
export declare const PRESS_RETRY_FIRST_MS: number;
export declare const BACKEND_TIMEOUT_MS: number;

/** How a bridge is made: where the backend is, its secret, and the seams a test replaces. */
export interface BridgeOptions {
  readonly backendUrl: string;
  readonly secret: string;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
  readonly log?: (line: Record<string, unknown>) => void;
  readonly syncIntervalMs?: number;
  readonly reconnectFirstMs?: number;
  readonly pressRetryFirstMs?: number;
  readonly helloTimeoutMs?: number;
  readonly maxConnectionMs?: number;
}

/** What the health check reports. */
export interface BridgeStatus {
  readonly synced: boolean;
  readonly syncedAt: number;
  readonly apps: ReadonlyArray<{
    readonly appId: string;
    readonly connected: boolean;
    readonly sockets: number;
  }>;
}

/** A running bridge. */
export interface Bridge {
  start(): Promise<void>;
  stop(): void;
  status(): BridgeStatus;
}

/** Make a bridge. */
export declare function createBridge(options: BridgeOptions): Bridge;
