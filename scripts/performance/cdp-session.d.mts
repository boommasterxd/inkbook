export class CdpSessionError extends Error {}

export interface CdpTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

export function discoverCdpTarget(options: {
  endpoint: string;
  targetId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<CdpTarget>;

export class CdpSession {
  public constructor(socket: WebSocket, timeoutMs?: number);
  public static connect(
    webSocketDebuggerUrl: string,
    options?: { WebSocketImpl?: typeof WebSocket; timeoutMs?: number },
  ): Promise<CdpSession>;
  public send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  public close(): void;
}
