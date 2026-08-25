import { createRoot } from "react-dom/client";
import { useLayoutEffect } from "react";

import { InkbookEditorChrome } from "./editor-chrome";
import type { InkbookEditorChromeProps } from "./editor-chrome";
import { sameEditorChromeProps } from "./editor-chrome-snapshot";

export interface MountedEditorChrome {
  readonly ready: Promise<boolean>;
  readonly update: (props: InkbookEditorChromeProps) => void;
  readonly unmount: () => void;
}

export function mountEditorChrome(
  container: HTMLElement,
  initialProps: InkbookEditorChromeProps,
): MountedEditorChrome {
  assertOwnerDocument(container, initialProps.ownerDocument);
  let mounted = true;
  let committed = false;
  let resolveReady = (_ready: boolean): void => undefined;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const root = createRoot(container);
  let renderedProps = initialProps;
  const onCommit = (): void => {
    if (!mounted || committed) return;
    committed = true;
    resolveReady(true);
  };
  renderChrome(root, initialProps, onCommit);

  return {
    ready,
    update(props) {
      if (!mounted) throw new Error("Cannot update an unmounted Inkbook editor chrome");
      assertOwnerDocument(container, props.ownerDocument);
      if (sameEditorChromeProps(renderedProps, props)) return;
      renderedProps = props;
      renderChrome(root, props, onCommit);
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      if (!committed) resolveReady(false);
      root.unmount();
    },
  };
}

function renderChrome(
  root: ReturnType<typeof createRoot>,
  props: InkbookEditorChromeProps,
  onCommit: () => void,
): void {
  root.render(<CommittedEditorChrome onCommit={onCommit} props={props} />);
}

function CommittedEditorChrome({
  onCommit,
  props,
}: {
  readonly onCommit: () => void;
  readonly props: InkbookEditorChromeProps;
}) {
  useLayoutEffect(onCommit, [onCommit]);
  return <InkbookEditorChrome {...props} />;
}

function assertOwnerDocument(container: HTMLElement, ownerDocument: Document): void {
  if (container.ownerDocument !== ownerDocument) {
    throw new Error("Inkbook editor chrome must mount in its owning document");
  }
}
