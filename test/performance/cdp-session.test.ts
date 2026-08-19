import { describe, expect, it, vi } from "vitest";

import {
  CdpSession,
  discoverCdpTarget,
} from "../../scripts/performance/cdp-session.mjs";

const ENDPOINT = "http://127.0.0.1:9222";

function discoveryResponse(targets: unknown): Response {
  return new Response(JSON.stringify(targets), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function target(id: string): Record<string, string> {
  return {
    id,
    type: "page",
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

class FakeSocket extends EventTarget {
  public readonly sent: string[] = [];
  public closed = false;

  public send(value: string): void {
    this.sent.push(value);
  }

  public close(): void {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }

  public respond(value: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

describe("CDP target discovery", () => {
  it("selects one exact loopback page target", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        discoveryResponse([target("first"), target("selected")]),
      );

    await expect(
      discoverCdpTarget({
        endpoint: ENDPOINT,
        fetchImpl,
        targetId: "selected",
      }),
    ).resolves.toEqual({
      id: "selected",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/selected",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed for remote endpoints and ambiguous targets", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(discoveryResponse([target("one"), target("two")]));

    await expect(
      discoverCdpTarget({ endpoint: "http://example.com:9222", fetchImpl }),
    ).rejects.toThrow(/loopback/);
    await expect(
      discoverCdpTarget({ endpoint: ENDPOINT, fetchImpl }),
    ).rejects.toThrow(/ambiguous/);
  });

  it("rejects malformed discovery data and cross-port sockets", async () => {
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not-json", { status: 200 }));
    const crossPort = vi.fn<typeof fetch>().mockResolvedValue(
      discoveryResponse([
        {
          ...target("one"),
          webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/one",
        },
      ]),
    );

    await expect(
      discoverCdpTarget({ endpoint: ENDPOINT, fetchImpl: malformed }),
    ).rejects.toThrow(/malformed/);
    await expect(
      discoverCdpTarget({ endpoint: ENDPOINT, fetchImpl: crossPort }),
    ).rejects.toThrow(/selected loopback port/);
  });
});

describe("CDP session", () => {
  it("correlates bounded protocol responses and closes idempotently", async () => {
    const socket = new FakeSocket();
    const session = new CdpSession(socket as unknown as WebSocket);
    const response = session.send("Runtime.enable");
    const request = JSON.parse(socket.sent[0] ?? "null") as { id: number };
    socket.respond({ id: request.id, result: { enabled: true } });

    await expect(response).resolves.toEqual({ enabled: true });
    session.close();
    session.close();
    expect(socket.closed).toBe(true);
    await expect(session.send("Runtime.enable")).rejects.toThrow(/closed/);
  });

  it("fails pending work on malformed or duplicate protocol identities", async () => {
    const socket = new FakeSocket();
    const session = new CdpSession(socket as unknown as WebSocket);
    const response = session.send("Runtime.getHeapUsage");
    socket.respond({ id: 999, result: {} });

    await expect(response).rejects.toThrow(/unknown or duplicate/);
    await expect(session.send("Runtime.enable")).rejects.toThrow(/closed/);
  });
});
