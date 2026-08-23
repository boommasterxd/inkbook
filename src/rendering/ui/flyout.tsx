import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

import { createFlyoutPositionLifecycle } from "./flyout-position";
import { createFlyoutPortalHost, registerFlyoutDismissal } from "./flyout-lifecycle";
import type {
  BackgroundFlyoutState,
  BackgroundSpacing,
  BackgroundType,
  ShapeId,
  StyleControl,
} from "./flyout-types";
import type { FlyoutId } from "./toolbar-types";

const BACKGROUNDS: readonly [BackgroundType, string][] = [
  ["none", "None"],
  ["lines", "Lines"],
  ["dots", "Dots"],
  ["squares", "Squares"],
];
const SPACINGS: readonly [BackgroundSpacing, string][] = [
  ["s", "S"],
  ["m", "M"],
  ["l", "L"],
  ["xl", "XL"],
];
const SHAPES: readonly [ShapeId, string][] = [
  ["line", "Line"],
  ["arrow", "Arrow"],
  ["rectangle", "Rectangle"],
  ["ellipse", "Ellipse"],
  ["triangle", "Triangle"],
  ["octagon", "Octagon"],
  ["parallelogram", "Parallelogram"],
  ["diamond", "Diamond"],
  ["coordinate-system", "Coordinate system"],
  ["table", "Table"],
];

export interface FlyoutPortalProps {
  readonly anchor: HTMLElement;
  readonly canvasInput: HTMLElement | null;
  readonly children: ReactNode;
  readonly id: FlyoutId;
  readonly label: string;
  readonly closing?: boolean;
  readonly onClose: () => void;
  readonly onExitComplete?: (() => void) | undefined;
  readonly ownerDocument: Document;
  readonly role?: "dialog" | "menu";
  readonly showTitle?: boolean;
}

export function FlyoutPortal(props: FlyoutPortalProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const portalHost = createFlyoutPortalHost(props.ownerDocument);
    setHost(portalHost);
    return () => portalHost.remove();
  }, [props.ownerDocument]);

  useEffect(() => {
    return registerFlyoutDismissal({
      anchor: props.anchor,
      canvasInput: props.canvasInput,
      onCanvasClose: props.onClose,
      onEscapeClose: props.onClose,
      ownerDocument: props.ownerDocument,
    });
  }, [props.anchor, props.canvasInput, props.onClose, props.ownerDocument]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const lifecycle = createFlyoutPositionLifecycle(panel, props.anchor, props.ownerDocument);
    return () => lifecycle.dispose();
  }, [host, props.anchor, props.ownerDocument]);

  if (host === null) return null;
  return createPortal(
    <div
      aria-label={props.label}
      aria-modal="false"
      className="inkbook-flyout"
      data-state={props.closing === true ? "closing" : "open"}
      id={`inkbook-${props.id}-flyout`}
      onAnimationEnd={(event) => {
        if (
          props.closing === true &&
          event.currentTarget === event.target &&
          event.animationName === "inkbook-flyout-exit"
        ) {
          if (event.currentTarget.contains(props.ownerDocument.activeElement)) props.anchor.focus();
          props.onExitComplete?.();
        }
      }}
      ref={panelRef}
      role={props.role ?? "dialog"}
    >
      {props.showTitle === false ? null : <div className="inkbook-flyout-title">{props.label}</div>}
      {props.children}
    </div>,
    host,
  );
}

interface BackgroundFlyoutProps {
  readonly onSpacingChange: (spacing: BackgroundSpacing) => void;
  readonly onTypeChange: (type: BackgroundType) => void;
  readonly state: BackgroundFlyoutState;
}

export function BackgroundFlyout(props: BackgroundFlyoutProps) {
  return (
    <>
      <ChoiceButtons
        label="Background type"
        onChange={props.onTypeChange}
        options={BACKGROUNDS}
        value={props.state.type}
      />
      {props.state.type === "none" ? null : (
        <ChoiceButtons
          label="Spacing"
          onChange={props.onSpacingChange}
          options={SPACINGS}
          value={props.state.spacing}
        />
      )}
    </>
  );
}

interface ShapeFlyoutProps {
  readonly onChange: (shape: ShapeId) => void;
  readonly value: ShapeId;
}

export function ShapeFlyout(props: ShapeFlyoutProps) {
  return (
    <ChoiceButtons label="Shape" onChange={props.onChange} options={SHAPES} value={props.value} />
  );
}

interface StyleFlyoutProps {
  readonly controls: readonly StyleControl[];
  readonly onChange: (controlId: string, value: boolean | number | string) => void;
}

export function StyleFlyout(props: StyleFlyoutProps) {
  if (props.controls.length === 0) {
    return <p className="inkbook-flyout-empty">No shared style options</p>;
  }
  return (
    <div className="inkbook-style-controls">
      {props.controls.map((control) => (
        <StyleField control={control} key={control.id} onChange={props.onChange} />
      ))}
    </div>
  );
}

interface ChoiceButtonsProps<T extends string> {
  readonly controlId?: string;
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly options: readonly (readonly [T, string])[];
  readonly value: T | null;
}

function ChoiceButtons<T extends string>(props: ChoiceButtonsProps<T>) {
  return (
    <fieldset className="inkbook-flyout-fieldset" data-control={props.controlId}>
      <legend>{props.label}</legend>
      <div className="inkbook-choice-grid">
        {props.options.map(([value, label]) => (
          <button
            aria-pressed={props.value === value}
            data-value={value}
            key={value}
            onClick={() => props.onChange(value)}
            type="button"
          >
            <ChoicePreview controlId={props.controlId} value={value} />
            <span className="inkbook-choice-label">{label}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function StyleField({
  control,
  onChange,
}: {
  readonly control: StyleControl;
  readonly onChange: StyleFlyoutProps["onChange"];
}) {
  if (control.kind === "toggle") {
    return (
      <label className="inkbook-style-field inkbook-style-toggle" data-control={control.id}>
        <span>{control.label}</span>
        <input
          checked={control.checked}
          onChange={(event) => onChange(control.id, event.currentTarget.checked)}
          type="checkbox"
        />
      </label>
    );
  }
  if (control.kind === "number") {
    return (
      <label className="inkbook-style-field inkbook-style-number" data-control={control.id}>
        <span>{control.label}</span>
        <input
          aria-label={control.mixed === true ? `${control.label}, mixed` : control.label}
          max={control.max}
          min={control.min}
          onChange={(event) => onChange(control.id, event.currentTarget.valueAsNumber)}
          placeholder={control.mixed === true ? "Mixed" : undefined}
          step={control.step}
          type="number"
          value={control.value ?? ""}
        />
      </label>
    );
  }
  return (
    <div className="inkbook-style-field" data-control={control.id}>
      <ChoiceButtons
        controlId={control.id}
        label={control.mixed === true ? `${control.label}, mixed` : control.label}
        onChange={(value) => onChange(control.id, value)}
        options={control.options.map((option) => [option.value, option.label] as const)}
        value={control.value}
      />
    </div>
  );
}

function ChoicePreview({
  controlId,
  value,
}: {
  readonly controlId: string | undefined;
  readonly value: string;
}) {
  if (controlId?.endsWith("color") === true) {
    const color = value === "theme-text" ? "var(--text-normal)" : value;
    const style = { "--inkbook-option-color": color } as CSSProperties;
    return (
      <span
        aria-hidden="true"
        className="inkbook-choice-preview inkbook-color-preview"
        data-empty={value === "none" ? "true" : undefined}
        style={style}
      />
    );
  }
  if (controlId?.endsWith("width") === true) {
    const width = Math.min(8, Math.max(2, Number(value) / 2));
    const style = { "--inkbook-option-line-width": `${String(width)}px` } as CSSProperties;
    return (
      <span
        aria-hidden="true"
        className="inkbook-choice-preview inkbook-line-preview"
        style={style}
      />
    );
  }
  if (controlId === "outline-style") {
    const style = { "--inkbook-option-line-style": value } as CSSProperties;
    return (
      <span
        aria-hidden="true"
        className="inkbook-choice-preview inkbook-line-preview"
        style={style}
      />
    );
  }
  return null;
}
