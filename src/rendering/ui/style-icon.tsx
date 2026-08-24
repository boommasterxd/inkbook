import type { ColorV1, OutlineStyleV1 } from "../../domain/schema/public";

export interface ToolbarStyleIconState {
  readonly fillColor: ColorV1 | null;
  readonly fillOpacity: number;
  readonly outlineColor: ColorV1 | null;
  readonly outlineStyle: OutlineStyleV1["outlineStyle"];
}

interface ToolbarStyleIconProps {
  readonly state: ToolbarStyleIconState;
}

const PALETTE_PATH =
  "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z";

export function ToolbarStyleIcon({ state }: ToolbarStyleIconProps) {
  const outlineColor = cssColor(state.outlineColor);
  const fillColor = state.fillColor === null ? "none" : cssColor(state.fillColor);
  const dashPattern = iconDashPattern(state.outlineStyle);
  return (
    <span aria-hidden="true" className="inkbook-toolbar-icon inkbook-toolbar-style-icon">
      <svg
        data-fill={state.fillColor === null ? "none" : "color"}
        data-outline-style={state.outlineStyle}
        fill="none"
        focusable="false"
        stroke={outlineColor}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d={PALETTE_PATH}
          fill={fillColor}
          fillOpacity={state.fillColor === null ? undefined : state.fillOpacity}
          strokeDasharray={dashPattern ?? undefined}
        />
        <circle cx="13.5" cy="6.5" fill={outlineColor} r=".5" />
        <circle cx="17.5" cy="10.5" fill={outlineColor} r=".5" />
        <circle cx="6.5" cy="12.5" fill={outlineColor} r=".5" />
        <circle cx="8.5" cy="7.5" fill={outlineColor} r=".5" />
      </svg>
    </span>
  );
}

function cssColor(color: ColorV1 | null): string {
  return color?.type === "rgba" ? color.value : "currentColor";
}

function iconDashPattern(style: OutlineStyleV1["outlineStyle"]): string | null {
  if (style === "dashed") return "3.4 2.4";
  if (style === "dotted") return ".5 2.5";
  return null;
}
