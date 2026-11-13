import { AnimatePresence, motion } from "motion/react";
import { useContext, useLayoutEffect, useRef } from "react";

import type { ColorV1, OutlineStyleV1 } from "../../domain/schema/public";
import { toolbarLayoutTransition, toolbarMotionContext } from "./toolbar-motion";

export interface ToolbarStyleIconState {
  readonly fillColor: ColorV1 | null;
  readonly fillOpacity: number;
  readonly outlineColor: ColorV1 | null;
  readonly outlineStyle: OutlineStyleV1["outlineStyle"];
  readonly text?: {
    readonly bold: boolean | null;
    readonly italic: boolean | null;
    readonly strikethrough: boolean | null;
    readonly underline: boolean | null;
  };
}

interface ToolbarStyleIconProps {
  readonly state: ToolbarStyleIconState;
  readonly textPreview?: boolean;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

const PALETTE_PATH =
  "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z";

export function ToolbarStyleIcon({
  state,
  textPreview = false,
  renderIcon,
}: ToolbarStyleIconProps) {
  const { reduced } = useContext(toolbarMotionContext);
  const text = textPreview ? state.text : undefined;
  const outlineColor = text === undefined ? cssColor(state.outlineColor) : "currentColor";
  const fillColor = state.fillColor === null ? "none" : cssColor(state.fillColor);
  const dashPattern = iconDashPattern(state.outlineStyle);
  const glyphKey =
    text === undefined
      ? "palette"
      : `text:${text.bold === true}:${text.italic === true}:${text.strikethrough === true}:${text.underline === true}`;
  const paintKey =
    text === undefined
      ? `${outlineColor}:${fillColor}:${state.fillOpacity}:${state.outlineStyle}:${glyphKey}`
      : glyphKey;
  return (
    <span
      aria-hidden="true"
      className={`inkbook-toolbar-icon inkbook-toolbar-style-icon${text === undefined ? "" : " inkbook-toolbar-text-icon"}`}
    >
      <svg
        data-fill={text !== undefined || state.fillColor === null ? "none" : "color"}
        data-outline-style={state.outlineStyle}
        fill="none"
        focusable="false"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <AnimatePresence initial={false}>
          <motion.g
            key={paintKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            stroke={outlineColor}
            transition={toolbarLayoutTransition(reduced)}
          >
            {text === undefined ? (
              <>
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
              </>
            ) : (
              <>
                {text.strikethrough === true ? <path d="M4 12h16" strokeWidth="1.6" /> : null}
                {text.underline === true ? <path d="M4 22h16" strokeWidth="1.6" /> : null}
              </>
            )}
          </motion.g>
        </AnimatePresence>
      </svg>
      {text === undefined ? null : <TextGlyph text={text} renderIcon={renderIcon} />}
    </span>
  );
}

function TextGlyph({
  text,
  renderIcon,
}: {
  readonly text: NonNullable<ToolbarStyleIconState["text"]>;
  readonly renderIcon: ToolbarStyleIconProps["renderIcon"];
}) {
  const { reduced } = useContext(toolbarMotionContext);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current !== null) renderIcon(ref.current, "type");
  }, [renderIcon]);
  useLayoutEffect(() => {
    ref.current?.querySelector("svg")?.setAttribute("stroke-width", text.bold === true ? "3" : "2");
  }, [renderIcon, text.bold]);
  return (
    <motion.span
      animate={{ skewX: text.italic === true ? -12 : 0 }}
      className="inkbook-toolbar-text-glyph"
      initial={false}
      ref={ref}
      transition={toolbarLayoutTransition(reduced)}
    />
  );
}

function cssColor(color: ColorV1 | null): string {
  if (color?.type === "rgba") return color.value;
  return "currentColor";
}

function iconDashPattern(style: OutlineStyleV1["outlineStyle"]): string | null {
  if (style === "dashed") return "3.4 2.4";
  if (style === "dotted") return ".5 2.5";
  return null;
}
