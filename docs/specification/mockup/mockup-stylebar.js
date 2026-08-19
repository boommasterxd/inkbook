"use strict";

function piStyleQuery(selector, root = document) {
  return root.querySelector(selector);
}

function piStyleQueryAll(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function piStyleEscape(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

function piSwatches(label = "Color", selected = true) {
  const safeLabel = piStyleEscape(label);
  return `<div class="style-control"><span class="control-label">${safeLabel}</span><div class="swatches" role="group" aria-label="${safeLabel}">
    <button class="swatch ${selected ? "is-selected" : ""}" style="--swatch:#7467e8" type="button" aria-label="Violet" aria-pressed="${selected}"></button>
    <button class="swatch" style="--swatch:#e05c75" type="button" aria-label="Rose" aria-pressed="false"></button>
    <button class="swatch" style="--swatch:#2d91a6" type="button" aria-label="Teal" aria-pressed="false"></button>
    <button class="swatch" style="--swatch:#25262a" type="button" aria-label="Ink" aria-pressed="false"></button>
  </div></div>`;
}

function piRange(label, value, min, max, unit) {
  const safeLabel = piStyleEscape(label);
  return `<div class="style-control"><label>${safeLabel}</label><input class="style-range" type="range" min="${min}" max="${max}" value="${value}" aria-label="${safeLabel}"><span class="value-chip">${value}${unit}</span></div>`;
}

function piTableCount(label, value) {
  const safeLabel = piStyleEscape(label);
  return `<div class="style-control"><label>${safeLabel}</label><input class="style-range" data-table-count="${safeLabel.toLowerCase()}" type="range" min="1" max="200" value="${value}" aria-label="${safeLabel}"><span class="value-chip">${value}</span></div>`;
}

function piSegmented(label, values, selected) {
  const buttons = values
    .map(
      (value) =>
        `<button type="button" class="${value === selected ? "is-selected" : ""}" data-value="${value}" aria-pressed="${value === selected}">${piStyleEscape(value)}</button>`,
    )
    .join("");
  return `<div class="style-control"><span class="control-label">${piStyleEscape(label)}</span><div class="segmented" role="group" aria-label="${piStyleEscape(label)}">${buttons}</div></div>`;
}

function piCapitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function piSelectionPanel(context) {
  const { state, elementStyleKind } = context;
  if (!state.selectedElements.length) {
    if (state.tool === "lasso")
      return `${piSegmented("Selection", ["Intersect", "50% area"], "Intersect")}<span class="control-label">Annotations only</span>`;
    return `<span class="control-label">Native text interaction on empty note content</span>`;
  }
  if (state.selectedElements.length > 1)
    return `${piSwatches("Mixed color", false)}${piRange("Opacity", 78, 10, 100, "%")}<span class="value-chip">Mixed</span><button class="toggle" type="button">Group</button><button class="toggle" type="button">Delete</button>`;
  const selectedKind = elementStyleKind[state.selectedElement] || "rectangle";
  return `${piPanelFor(selectedKind, context)}<button class="toggle" type="button">Text anchor</button><button class="toggle" type="button">Bring forward</button><button class="toggle" type="button">Delete</button>`;
}

function piBackgroundPanel(state) {
  return `${piSegmented("Pattern", ["None", "Ruled", "Squared", "Dotted"], piCapitalize(state.background))}${piSegmented("Spacing", ["Compact", "Standard", "Wide"], piCapitalize(state.backgroundSpacing))}${piSegmented("Contrast", ["Low", "Medium", "High"], piCapitalize(state.backgroundContrast))}<button class="toggle" data-action="reset-background" type="button">Reset default</button>`;
}

function piPanelFor(kind, context) {
  const { state, elementDimensions } = context;
  if (kind === "cursor" || kind === "lasso") return piSelectionPanel(context);
  if (kind === "pen")
    return `${piSwatches()}${piRange("Width", 3, 1, 18, " px")}${piRange("Opacity", 100, 10, 100, "%")}<button class="toggle" data-toggle="pressure" type="button" aria-pressed="${state.pressure}">Pressure ${state.pressure ? "on" : "off"}</button>${piRange("Smoothing", 62, 0, 100, "%")}${piRange("Streamline", 50, 0, 100, "%")}${piRange("Thinning", 55, 0, 100, "%")}`;
  if (kind === "highlighter" || kind === "line-highlighter")
    return `${piSwatches()}${piRange("Width", 12, 4, 36, " px")}${piRange("Opacity", 35, 10, 80, "%")}${piSegmented("Stroke", ["Free", "Line"], kind === "line-highlighter" ? "Line" : "Free")}`;
  if (kind === "eraser")
    return `${piRange("Radius", 12, 4, 40, " px")}<span class="control-label">Whole-element eraser</span>`;
  if (kind === "background") return piBackgroundPanel(state);
  if (["arrow", "line"].includes(kind))
    return `${piSwatches()}${piRange("Width", 3, 1, 12, " px")}${piRange("Opacity", 100, 10, 100, "%")}${piSegmented("Line", ["Solid", "Dashed", "Dotted"], "Solid")}${piSegmented("Path", ["Straight", "Curved"], "Straight")}${piSegmented("Start", ["None", "Arrow", "Dot", "Circle", "Diamond", "Bar"], "None")}${piSegmented("End", ["None", "Arrow", "Dot", "Circle", "Diamond", "Bar"], kind === "arrow" ? "Arrow" : "None")}<span class="value-chip">Endpoints snap to object ports</span><button class="toggle" type="button">Detach endpoint</button>`;
  if (kind === "coordinate-system") {
    const selectedDimensions =
      elementDimensions[state.selectedElement] || state.coordinateDimensions;
    const dimensions = state.selectedElements.length
      ? `<span class="value-chip" aria-label="Dimensions">${selectedDimensions}</span>`
      : piSegmented("Dimensions", ["2D", "3D"], state.coordinateDimensions);
    return `${piSwatches()}${piRange("Width", 2, 1, 12, " px")}${piRange("Opacity", 100, 10, 100, "%")}${piSegmented("Line", ["Solid", "Dashed", "Dotted"], "Solid")}${piSegmented("Positive end", ["None", "Arrow", "Dot", "Circle", "Diamond", "Bar"], "Arrow")}${dimensions}${piRange("Grid density", 5, 0, 64, "")}`;
  }
  if (kind === "table") {
    const counts = state.selectedElement
      ? state.tableCounts[state.selectedElement]
      : state.tableDefaults;
    return `${piSwatches()}${piRange("Width", 2, 1, 12, " px")}${piRange("Opacity", 100, 10, 100, "%")}${piTableCount("Rows", counts.rows)}${piTableCount("Columns", counts.columns)}${piSegmented("Line", ["Solid", "Dashed", "Dotted"], "Solid")}`;
  }
  return `${piSwatches("Outline")}${piRange("Width", 2, 1, 12, " px")}${piRange("Outline opacity", 100, 0, 100, "%")}${piSegmented("Line", ["Solid", "Dashed", "Dotted"], "Solid")}${piSegmented("Fill", ["None", "Solid"], "None")}${piSwatches("Fill color")}${piRange("Fill opacity", 100, 0, 100, "%")}`;
}

function piSelectSegment(button) {
  piStyleQueryAll("button", button.parentElement).forEach((item) => {
    item.classList.remove("is-selected");
    item.setAttribute("aria-pressed", "false");
  });
  button.classList.add("is-selected");
  button.setAttribute("aria-pressed", "true");
}

function piUpdateRange(input) {
  const chip = input.nextElementSibling;
  const unit = chip.textContent.replace(/[\d.]/g, "");
  chip.textContent = `${input.value}${unit}`;
}

function piSetBackground(context, option, value) {
  const { state } = context;
  if (option === "Pattern") state.background = value;
  if (option === "Spacing") state.backgroundSpacing = value;
  if (option === "Contrast") state.backgroundContrast = value;
  const note = piStyleQuery("#markdown-note");
  const spacing = { compact: "22px", standard: "28px", wide: "36px" }[
    state.backgroundSpacing
  ];
  const contrast = { low: "14%", medium: "22%", high: "32%" }[
    state.backgroundContrast
  ];
  note.className = `markdown-note background-${state.background}`;
  note.style.setProperty("--grid-x", spacing);
  note.style.setProperty("--grid-strength", contrast);
}

function piWireStylebar(context) {
  const { state, elementStyleKind } = context;
  const stylebar = piStyleQuery("#stylebar");
  piStyleQueryAll(".swatch", stylebar).forEach((button) =>
    button.addEventListener("click", () => {
      piStyleQueryAll(".swatch", button.closest(".swatches")).forEach(
        (item) => {
          item.classList.remove("is-selected");
          item.setAttribute("aria-pressed", "false");
        },
      );
      button.classList.add("is-selected");
      button.setAttribute("aria-pressed", "true");
    }),
  );
  piStyleQueryAll(".segmented button", stylebar).forEach((button) =>
    button.addEventListener("click", () => {
      piSelectSegment(button);
      if (button.parentElement.getAttribute("aria-label") === "Dimensions")
        state.coordinateDimensions = button.dataset.value;
    }),
  );
  piStyleQueryAll(".style-range", stylebar).forEach((input) =>
    input.addEventListener("input", () => {
      piUpdateRange(input);
      const selectedTable = elementStyleKind[state.selectedElement] === "table";
      const counts = selectedTable
        ? state.tableCounts[state.selectedElement]
        : state.tableDefaults;
      if (input.dataset.tableCount === "rows")
        counts.rows = Number(input.value);
      if (input.dataset.tableCount === "columns")
        counts.columns = Number(input.value);
      if (input.dataset.tableCount && selectedTable) context.updateTable();
    }),
  );
  const pressure = piStyleQuery("[data-toggle='pressure']", stylebar);
  if (pressure)
    pressure.addEventListener("click", (event) => {
      state.pressure = !state.pressure;
      event.currentTarget.setAttribute("aria-pressed", String(state.pressure));
      event.currentTarget.textContent = `Pressure ${state.pressure ? "on" : "off"}`;
    });
  if (state.tool === "background")
    piStyleQueryAll(".segmented", stylebar).forEach((group) => {
      const option = group.getAttribute("aria-label");
      piStyleQueryAll("button", group).forEach((button) =>
        button.addEventListener("click", () =>
          piSetBackground(context, option, button.dataset.value.toLowerCase()),
        ),
      );
    });
  const resetBackground = piStyleQuery(
    "[data-action='reset-background']",
    stylebar,
  );
  if (resetBackground)
    resetBackground.addEventListener("click", () => {
      state.background = "none";
      state.backgroundSpacing = "standard";
      state.backgroundContrast = "low";
      piSetBackground(context, "Pattern", "none");
      piRenderStylebar(context);
    });
}

function piRenderStylebar(context) {
  const { state, toolLabels } = context;
  const stylebar = piStyleQuery("#stylebar");
  const hasSelection = state.selectedElements.length > 0;
  const kind = hasSelection ? "cursor" : state.tool;
  const shouldShow = hasSelection || state.tool !== "cursor";
  stylebar.hidden = !shouldShow;
  if (!shouldShow) return;
  const title = hasSelection
    ? `${state.selectedElements.length} selected`
    : toolLabels[kind] || "Tool";
  stylebar.innerHTML = `<div class="style-heading"><span class="context-dot"></span>${piStyleEscape(title)}</div>${piPanelFor(kind, context)}`;
  piWireStylebar(context);
}

window.InkbookMockupStylebar = Object.freeze({ render: piRenderStylebar });
