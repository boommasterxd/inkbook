import type { ClipboardWritePayload } from "./types";

export interface ClipboardWritePort<Item> {
  createItem(formats: ReadonlyMap<string, Promise<string>>): Item;
  write(items: readonly Item[]): Promise<void>;
  retainSessionPayload(payload: ClipboardWritePayload): void;
}

export interface ClipboardWriteAttempt {
  mode: "plain-only" | "unavailable";
  payloadReady: Promise<ClipboardWritePayload>;
  systemWrite: Promise<boolean>;
}

const settledWrite = <Item>(port: ClipboardWritePort<Item>, item: Item): Promise<boolean> => {
  try {
    return Promise.resolve(port.write([item])).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
};

export const beginClipboardWriteDuringActivation = <Item>(
  port: ClipboardWritePort<Item>,
  payloadReady: Promise<ClipboardWritePayload>,
): ClipboardWriteAttempt => {
  const retainedPayloadReady = payloadReady.then((payload) => {
    port.retainSessionPayload(payload);
    return payload;
  });
  const plain = retainedPayloadReady.then(({ plainText }) => plainText);
  try {
    const item = port.createItem(new Map([["text/plain", plain]]));
    return {
      mode: "plain-only",
      payloadReady: retainedPayloadReady,
      systemWrite: settledWrite(port, item),
    };
  } catch {
    return {
      mode: "unavailable",
      payloadReady: retainedPayloadReady,
      systemWrite: Promise.resolve(false),
    };
  }
};
