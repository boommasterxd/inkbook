const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DISCOVERY_BYTES = 1_048_576;
const MAX_TARGETS = 64;
const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_PENDING_REQUESTS = 16;

export class CdpSessionError extends Error {
  constructor(message) {
    super(message);
    this.name = "CdpSessionError";
  }
}

function fail(message) {
  throw new CdpSessionError(message);
}

function isLoopback(hostname) {
  return ["127.0.0.1", "::1", "localhost"].includes(hostname);
}

function parseEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    fail("CDP endpoint must be a valid URL");
  }
  if (
    url.protocol !== "http:" ||
    !isLoopback(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail("CDP endpoint must be an unauthenticated loopback HTTP URL");
  }
  return url;
}

async function readBoundedText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DISCOVERY_BYTES) {
    fail("CDP target response exceeds the discovery byte limit");
  }
  if (!response.body) fail("CDP target response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DISCOVERY_BYTES) {
      await reader.cancel();
      fail("CDP target response exceeds the discovery byte limit");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function validateWebSocketUrl(value, endpoint) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("CDP target has an invalid WebSocket URL");
  }
  if (
    url.protocol !== "ws:" ||
    !isLoopback(url.hostname) ||
    url.port !== endpoint.port ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    fail("CDP target WebSocket must use the selected loopback port");
  }
  return url.href;
}

function selectTarget(targets, targetId, endpoint) {
  if (!Array.isArray(targets) || targets.length > MAX_TARGETS) {
    fail("CDP target list is malformed or exceeds its limit");
  }
  const candidates = targets.filter(
    (target) =>
      target &&
      typeof target === "object" &&
      ["page", "webview"].includes(target.type) &&
      typeof target.id === "string" &&
      typeof target.webSocketDebuggerUrl === "string",
  );
  const selected = targetId
    ? candidates.filter((target) => target.id === targetId)
    : candidates;
  if (selected.length !== 1) {
    fail(
      targetId
        ? "The requested CDP target is missing or duplicated"
        : "CDP target selection is ambiguous; provide one exact target ID",
    );
  }
  const target = selected[0];
  return {
    id: target.id,
    webSocketDebuggerUrl: validateWebSocketUrl(
      target.webSocketDebuggerUrl,
      endpoint,
    ),
  };
}

export async function discoverCdpTarget({
  endpoint,
  targetId,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const base = parseEndpoint(endpoint);
  const listUrl = new URL("json/list", `${base.href.replace(/\/$/, "")}/`);
  let response;
  try {
    response = await fetchImpl(listUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail(`Cannot query the loopback CDP endpoint: ${error.message}`);
  }
  if (!response.ok) fail(`CDP target query returned HTTP ${response.status}`);
  let targets;
  try {
    targets = JSON.parse(await readBoundedText(response));
  } catch (error) {
    if (error instanceof CdpSessionError) throw error;
    fail(`CDP target response is malformed: ${error.message}`);
  }
  return selectTarget(targets, targetId, base);
}

function eventData(event) {
  return typeof event.data === "string" ? event.data : undefined;
}

function waitForSocketOpen(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new CdpSessionError("CDP socket connection failed"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new CdpSessionError("CDP socket connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
  });
}

export class CdpSession {
  #nextId = 1;
  #pending = new Map();
  #socket;
  #timeoutMs;
  #closed = false;

  constructor(socket, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.addEventListener("message", (event) => this.#receive(event));
    socket.addEventListener("close", () =>
      this.#terminate("CDP socket closed"),
    );
    socket.addEventListener("error", () =>
      this.#terminate("CDP socket failed"),
    );
  }

  static async connect(
    webSocketDebuggerUrl,
    {
      WebSocketImpl = globalThis.WebSocket,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = {},
  ) {
    if (typeof WebSocketImpl !== "function") {
      fail("This Node.js runtime does not provide WebSocket");
    }
    const socket = new WebSocketImpl(webSocketDebuggerUrl);
    try {
      await waitForSocketOpen(socket, timeoutMs);
    } catch (error) {
      socket.close();
      throw error;
    }
    return new CdpSession(socket, timeoutMs);
  }

  send(method, params = {}) {
    if (this.#closed)
      return Promise.reject(new CdpSessionError("CDP session is closed"));
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new CdpSessionError("CDP pending request limit reached"),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpSessionError(`CDP ${method} timed out`));
      }, this.#timeoutMs);
      this.#pending.set(id, { method, reject, resolve, timeout });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.#closed) return;
    this.#terminate("CDP session closed");
    this.#socket.close();
  }

  #receive(event) {
    const data = eventData(event);
    if (data === undefined || Buffer.byteLength(data) > MAX_MESSAGE_BYTES) {
      this.#terminate("CDP message is not bounded UTF-8 text");
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.#terminate("CDP message is malformed JSON");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#terminate("CDP message is not a protocol object");
      return;
    }
    if (!("id" in message)) {
      if (typeof message.method === "string") return;
      this.#terminate("CDP event is malformed");
      return;
    }
    if (!Number.isInteger(message.id) || message.id < 1) {
      this.#terminate("CDP response has an invalid request ID");
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) {
      this.#terminate("CDP response has an unknown or duplicate request ID");
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new CdpSessionError(
          `CDP ${pending.method} failed: ${String(message.error.message)}`,
        ),
      );
      return;
    }
    if (!("result" in message)) {
      pending.reject(
        new CdpSessionError(`CDP ${pending.method} has no result`),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #terminate(message) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CdpSessionError(message));
    }
    this.#pending.clear();
  }
}
