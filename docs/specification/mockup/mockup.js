"use strict";

const state = {
  tool: "cursor",
  selectedElement: null,
  selectedElements: [],
  zoom: 100,
  pressure: true,
  coordinateDimensions: "2D",
  tableDefaults: { rows: 3, columns: 3 },
  tableCounts: { "table-1": { rows: 4, columns: 5 } },
  background: "ruled",
  backgroundSpacing: "standard",
  backgroundContrast: "low",
  theme: "light",
  compact: false,
  presentation: "floating",
};

const toolLabels = {
  cursor: "Cursor",
  lasso: "Lasso",
  pen: "Pen",
  highlighter: "Highlighter",
  eraser: "Eraser",
  rectangle: "Rectangle",
  arrow: "Arrow",
  "line-highlighter": "Line highlighter",
  ellipse: "Ellipse",
  triangle: "Triangle",
  diamond: "Diamond",
  octagon: "Octagon",
  line: "Line",
  connector: "Connector",
  "coordinate-system": "Coordinate system",
  table: "Table",
  background: "Background",
};

const elementStyleKind = {
  "highlight-1": "highlighter",
  "stroke-1": "pen",
  "stroke-2": "pen",
  "arrow-1": "arrow",
  "shape-1": "rectangle",
  "axes-1": "coordinate-system",
  "table-1": "table",
};

const elementDimensions = {
  "axes-1": "3D",
};

const query = (selector, root = document) => root.querySelector(selector);
const queryAll = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

const stylebarContext = Object.freeze({
  state,
  toolLabels,
  elementStyleKind,
  elementDimensions,
  updateTable,
});
const renderStylebar = () =>
  window.InkbookMockupStylebar.render(stylebarContext);

function showStatus(message) {
  const toast = query("#status-toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function updateTable() {
  const table = query("#table-preview");
  if (!table) return;
  const x = 492;
  const y = 486;
  const width = 220;
  const height = 128;
  const commands = [];
  const counts = state.tableCounts["table-1"];
  for (let column = 1; column < counts.columns; column += 1) {
    const offset = x + (width * column) / counts.columns;
    commands.push(`M${offset} ${y}V${y + height}`);
  }
  for (let row = 1; row < counts.rows; row += 1) {
    const offset = y + (height * row) / counts.rows;
    commands.push(`M${x} ${offset}H${x + width}`);
  }
  query(".table-dividers", table).setAttribute("d", commands.join(""));
}

function selectTool(tool) {
  state.tool = tool;
  state.selectedElement = null;
  state.selectedElements = [];
  queryAll(".ink-element").forEach((element) => {
    element.classList.remove("is-selected");
    element.setAttribute("aria-pressed", "false");
  });
  query("#selection-chrome").hidden = true;
  queryAll("[data-tool]", query(".annotation-toolbar")).forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle("is-active", active);
    if (button.hasAttribute("aria-pressed"))
      button.setAttribute("aria-pressed", String(active));
  });
  queryAll("[role='menuitemradio']").forEach((button) =>
    button.setAttribute("aria-checked", String(button.dataset.tool === tool)),
  );
  renderStylebar();
}

function selectElement(element, additive) {
  const elementId = element.dataset.element;
  state.selectedElements =
    additive && state.selectedElements.length
      ? [...new Set([...state.selectedElements, elementId])]
      : [elementId];
  state.selectedElement = elementId;
  state.tool = "cursor";
  closeMoreMenu(false);
  queryAll(".ink-element").forEach((item) => {
    const selected = state.selectedElements.includes(item.dataset.element);
    item.classList.toggle("is-selected", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
  selectToolButtonOnly("cursor");
  positionSelection(
    queryAll(".ink-element").filter((item) =>
      state.selectedElements.includes(item.dataset.element),
    ),
  );
  renderStylebar();
}

function selectToolButtonOnly(tool) {
  queryAll("[data-tool]", query(".annotation-toolbar")).forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle("is-active", active);
    if (button.hasAttribute("aria-pressed"))
      button.setAttribute("aria-pressed", String(active));
  });
}

function positionSelection(elements) {
  const boxes = elements.map((element) => element.getBBox());
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const box = { x: left, y: top, width: right - left, height: bottom - top };
  const padding = 9;
  const chrome = query("#selection-chrome");
  const rect = query(".selection-box", chrome);
  const handles = queryAll(".selection-handle", chrome);
  const anchor = query(".anchor-handle", chrome);
  const anchorLine = query(".anchor-line", chrome);
  rect.setAttribute("x", box.x - padding);
  rect.setAttribute("y", box.y - padding);
  rect.setAttribute("width", box.width + padding * 2);
  rect.setAttribute("height", box.height + padding * 2);
  handles[0].setAttribute("cx", box.x - padding);
  handles[0].setAttribute("cy", box.y - padding);
  handles[1].setAttribute("cx", box.x + box.width + padding);
  handles[1].setAttribute("cy", box.y + box.height + padding);
  anchor.setAttribute("cx", box.x - 26);
  anchor.setAttribute("cy", box.y + box.height / 2);
  anchorLine.setAttribute(
    "d",
    `M${box.x - 19} ${box.y + box.height / 2}H${box.x - padding}`,
  );
  chrome.hidden = false;
}

function setZoom(nextZoom) {
  state.zoom = Math.max(50, Math.min(400, nextZoom));
  document.documentElement.style.setProperty(
    "--note-zoom",
    String(state.zoom / 100),
  );
  query("#zoom-reset").textContent = `${state.zoom}%`;
  syncNoteSize();
  showStatus(`Whole note zoom: ${state.zoom}%`);
}

function closeMoreMenu(restoreFocus) {
  const button = query("#more-tools-button");
  query("#more-tools-menu").hidden = true;
  button.setAttribute("aria-expanded", "false");
  if (restoreFocus) button.focus();
}

function toggleMoreMenu() {
  const menu = query("#more-tools-menu");
  const opening = menu.hidden;
  menu.hidden = !opening;
  query("#more-tools-button").setAttribute("aria-expanded", String(opening));
  if (opening) {
    const items = queryAll("[role='menuitemradio']", menu);
    const target =
      items.find((item) => item.dataset.tool === state.tool) || items[0];
    items.forEach((item) => {
      item.tabIndex = item === target ? 0 : -1;
    });
    target.focus();
  }
}

function handleMenuKeydown(event) {
  const items = queryAll("[role='menuitemradio']", event.currentTarget);
  const current = items.indexOf(document.activeElement);
  let next = current;
  if (event.key === "ArrowDown") next = (current + 1) % items.length;
  else if (event.key === "ArrowUp")
    next = (current - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (event.key === "Escape") {
    event.preventDefault();
    closeMoreMenu(true);
    return;
  } else return;
  event.preventDefault();
  items.forEach((item, index) => {
    item.tabIndex = index === next ? 0 : -1;
  });
  items[next].focus();
}

function wirePreviewControls() {
  query("#theme-toggle").addEventListener("click", (event) => {
    state.theme = state.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = state.theme;
    event.currentTarget.setAttribute(
      "aria-pressed",
      String(state.theme === "dark"),
    );
  });
  query("#viewport-toggle").addEventListener("click", (event) => {
    state.compact = !state.compact;
    query("#app-shell").classList.toggle("compact-preview", state.compact);
    event.currentTarget.setAttribute("aria-pressed", String(state.compact));
  });
  query("#presentation-toggle").addEventListener("click", (event) => {
    state.presentation =
      state.presentation === "floating" ? "docked" : "floating";
    query("#annotation-shell").className =
      `annotation-shell ${state.presentation}`;
    event.currentTarget.setAttribute(
      "aria-pressed",
      String(state.presentation === "docked"),
    );
    event.currentTarget.textContent =
      state.presentation === "docked" ? "Float toolbar" : "Dock toolbar";
  });
}

function wireToolbar() {
  queryAll(".annotation-toolbar [data-tool]").forEach((button) =>
    button.addEventListener("click", () => selectTool(button.dataset.tool)),
  );
  query("#more-tools-button").addEventListener("click", toggleMoreMenu);
  query("#more-tools-menu").addEventListener("keydown", handleMenuKeydown);
  queryAll("[role='menuitemradio']").forEach((button) =>
    button.addEventListener("click", () => {
      selectTool(button.dataset.tool);
      closeMoreMenu(true);
    }),
  );
  query("#zoom-out").addEventListener("click", () => setZoom(state.zoom - 10));
  query("#zoom-in").addEventListener("click", () => setZoom(state.zoom + 10));
  query("#zoom-reset").addEventListener("click", () => setZoom(100));
  query("#settings-button").addEventListener("click", () =>
    showStatus("Production action: open Inkbook in Obsidian Settings"),
  );
  query("[data-action='redo']").addEventListener("click", () =>
    showStatus("Annotation redo preview"),
  );
}

function wireScene() {
  queryAll(".ink-element").forEach((element) => {
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.setAttribute(
      "aria-label",
      `${toolLabels[elementStyleKind[element.dataset.element]] || "Annotation"} annotation`,
    );
    element.setAttribute("aria-pressed", "false");
    element.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      selectElement(element, event.shiftKey);
    });
  });
  queryAll(".ink-element, .ink-hit").forEach((target) =>
    target.addEventListener("pointerdown", (event) => {
      if (
        event.pointerType !== "touch" &&
        !["cursor", "lasso"].includes(state.tool)
      )
        return;
      const elementId = target.dataset.element || target.dataset.hit;
      const element = query(`[data-element='${elementId}']`);
      event.preventDefault();
      event.stopPropagation();
      selectElement(element, event.shiftKey);
    }),
  );
}

function syncNoteSize() {
  const note = query("#markdown-note");
  const zoom = query("#note-zoom");
  const scale = state.zoom / 100;
  zoom.style.width = `${note.offsetWidth * scale}px`;
  zoom.style.height = `${note.scrollHeight * scale}px`;
  query("#ink-overlay").setAttribute(
    "viewBox",
    `0 0 ${note.offsetWidth} ${note.scrollHeight}`,
  );
}

function measureHostLineHeight() {
  const note = query("#markdown-note");
  const lineHeight = Number.parseFloat(getComputedStyle(note).lineHeight);
  if (Number.isFinite(lineHeight))
    note.style.setProperty("--body-line-height", `${lineHeight}px`);
}

function wireGlobalDismiss() {
  document.addEventListener("pointerdown", (event) => {
    const menu = query("#more-tools-menu");
    if (!menu.hidden && !event.target.closest(".menu-wrap"))
      closeMoreMenu(false);
  });
}

wirePreviewControls();
wireToolbar();
wireScene();
wireGlobalDismiss();
measureHostLineHeight();
updateTable();
syncNoteSize();
query(".markdown-content").addEventListener("input", syncNoteSize);
window.addEventListener("resize", syncNoteSize);
