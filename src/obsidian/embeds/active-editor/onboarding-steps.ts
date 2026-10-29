import type { CoachStep } from "./onboarding-coach";

export const ONBOARDING_STEPS: readonly CoachStep[] = [
  {
    action: "finger-drawing",
    title: "draw with a finger",
    lines: ["allow finger ink", "for this editor"],
    optional: true,
    description:
      "Finger drawing: When enabled in this device and vault's settings, this toolbar toggle allows finger drawing in the current editor. Otherwise touch remains available for navigation and selection.",
  },
  {
    action: "undo",
    title: "try another way",
    lines: ["undo a change", "redo brings it back"],
    description:
      "Undo and Redo: Undo reverses your last drawing change. The adjacent Redo button restores an undone change. Each is disabled when its history action is unavailable.",
  },
  {
    action: "select",
    title: "select your ink",
    lines: ["lasso or rectangle", "move and resize it"],
    description:
      "Select: Click or tap an element to select it. With a mouse or pen, drag a lasso or rectangle around ink, then move or resize the selection. With Select active and no selection, Style lets you choose Lasso or Rectangle and the inclusion rule. Touch can tap to select, but does not draw selection areas.",
  },
  {
    action: "eraser",
    title: "erase whole marks",
    lines: ["sweep over ink", "undo brings it back"],
    description:
      "Eraser: Sweep across elements to remove them completely. It does not erase only part of a stroke or shape. Adjust the eraser radius in Style. One sweep is one undo step.",
  },
  {
    action: "draw",
    title: "make your first mark",
    lines: ["a pen or mouse", "is all you need"],
    description:
      "Draw: Write or sketch freely with a pen or mouse. Style controls color, width, opacity and pen pressure sensitivity for new strokes.",
  },
  {
    action: "highlighter",
    title: "mark what matters",
    lines: ["highlight freely", "beneath your ink"],
    description:
      "Highlighter: Draw freehand highlights with a constant width below regular ink and shapes. Use Style to change their color, width and opacity.",
  },
  {
    action: "straight-highlighter",
    title: "keep it straight",
    lines: ["drag a clean line", "from start to end"],
    description:
      "Straight highlighter: Drag from a start point to an end point to create a straight highlight. Select it later to adjust its endpoints or bend it with the middle handle.",
  },
  {
    action: "shape",
    title: "draw your shape",
    lines: ["your chosen shape", "is ready to draw"],
    description:
      "Active shape: Activate the shape currently shown by this icon, then drag on the page to create it. This button uses your current shape choice.",
  },
  {
    action: "shape-picker",
    title: "choose a shape",
    lines: ["lines and arrows", "shapes and tables"],
    description:
      "Choose shape: Pick a line, arrow, closed shape, coordinate system or table. This updates the adjacent Active shape control and activates that shape tool.",
  },
  {
    action: "style",
    title: "make it yours",
    lines: ["style your tool", "or selected ink"],
    description:
      "Style: With no selection, adjust the active tool for future elements. With elements selected, edit their supported shared properties instead. Available controls depend on the tool or selection. Select also offers Lasso and Rectangle options here when the selection is empty.",
  },
  {
    action: "lock",
    title: "back to your note",
    lines: ["lock to finish editing", "tap to edit again"],
    description:
      "Lock: Changes save automatically. Lock finishes editing; click or tap the saved preview to return.",
  },
  {
    action: "overflow",
    title: "a little more",
    lines: ["paper and settings", "shortcuts and more"],
    description:
      "More options: Change the paper background, open settings and keyboard help, manage or arrange content, and reopen this tour. Destructive cleanup actions are also kept here.",
  },
  {
    action: "paste",
    title: "bring ink here",
    lines: ["paste copied ink", "into this drawing"],
    previewContext: true,
    description:
      "Paste: Insert supported copied Inkbook content into this drawing. This side control appears when clipboard reading is supported or an in-session clipboard payload exists. The tour is only showing the controls; it does not read or change your clipboard.",
  },
  {
    action: "copy",
    title: "keep a copy",
    lines: ["select some ink", "copy for later"],
    previewContext: true,
    description:
      "Copy: Copy selected elements without removing them. This side control normally appears only with a selection. The tour shows a non-interactive preview without selecting or copying anything.",
  },
  {
    action: "cut",
    title: "move it elsewhere",
    lines: ["copy selected ink", "and remove it here"],
    previewContext: true,
    description:
      "Cut: Copy selected elements and remove them from this drawing. This side control normally appears only with a selection, and its removal can be undone. This tour preview does not perform either action.",
  },
  {
    action: "delete",
    title: "remove selected ink",
    lines: ["keep the rest intact", "undo brings it back"],
    previewContext: true,
    description:
      "Delete: Remove selected elements without copying them. This side control normally appears only with a selection. Undo restores removed elements. This tour preview does not delete anything.",
  },
  {
    action: "overflow",
    title: "make inkbook yours",
    lines: ["open plugin settings", "choose what works for you"],
    description:
      "Plugin settings: Open More options, then Settings to personalize Inkbook. Adjust tool defaults, paper, input and other preferences to suit the way you work.",
  },
];
