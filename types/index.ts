export type SelectionTool = "marquee" | "brush";

/** How the next removal pass will run (derived from detection confidence). */
export type PlannedRemovalMode = "alpha" | "inpaint" | "dual-fallback";

export interface EditorSettings {
  tool: SelectionTool;
  brushSize: number;
  featherPx: number;
}

export interface ClickPoint {
  x: number;
  y: number;
}

export interface MaskRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  tool: "marquee",
  brushSize: 24,
  featherPx: 12,
};
