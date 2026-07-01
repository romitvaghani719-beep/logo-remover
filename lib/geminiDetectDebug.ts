import type { MaskRegion } from "@/types";
import {
  CORNER_SEARCH_FRACTION,
  CORNER_SEARCH_FALLBACK_FRACTION,
} from "@/lib/geminiSearchZone";

export interface DetectionDebugStep {
  id: string;
  title: string;
  description: string;
  width: number;
  height: number;
  imageDataUrl: string;
}

export interface DetectionDebugMeta {
  naturalWidth: number;
  naturalHeight: number;
  searchWidth: number;
  searchHeight: number;
  searchScale: number;
  matchedZoneFraction: number | null;
  found: boolean;
  confidence: number | null;
  templateSize: number | null;
  region: MaskRegion | null;
}

export class DetectionDebugCollector {
  readonly steps: DetectionDebugStep[] = [];
  meta: Partial<DetectionDebugMeta> = {};

  add(step: DetectionDebugStep): void {
    this.steps.push(step);
  }
}

function createCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    return { canvas, ctx };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  return { canvas, ctx };
}

async function canvasToDataUrl(
  canvas: HTMLCanvasElement | OffscreenCanvas
): Promise<string> {
  if ("convertToBlob" in canvas) {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(blob);
  }

  return (canvas as HTMLCanvasElement).toDataURL("image/png");
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function imageDataToStep(
  id: string,
  title: string,
  description: string,
  data: ImageData
): Promise<DetectionDebugStep> {
  const { canvas, ctx } = createCanvas(data.width, data.height);
  ctx.putImageData(data, 0, 0);
  const imageDataUrl = await canvasToDataUrl(canvas);
  return { id, title, description, width: data.width, height: data.height, imageDataUrl };
}

export async function floatFieldToStep(
  id: string,
  title: string,
  description: string,
  field: Float32Array,
  width: number,
  height: number,
  mode: "gray" | "heatmap" = "heatmap"
): Promise<DetectionDebugStep> {
  let min = Infinity;
  let max = -Infinity;
  const finite: number[] = [];
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (!Number.isFinite(v)) continue;
    finite.push(v);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  finite.sort((a, b) => a - b);
  const pLow = finite[Math.floor(finite.length * 0.02)] ?? min;
  const pHigh = finite[Math.floor(finite.length * 0.98)] ?? max;
  const span = mode === "heatmap" ? pHigh - pLow || 1 : max - min || 1;
  const base = mode === "heatmap" ? pLow : min;

  const out = new ImageData(width, height);
  for (let i = 0; i < field.length; i++) {
    const o = i * 4;
    const v = field[i];
    if (!Number.isFinite(v)) {
      out.data[o] = 0;
      out.data[o + 1] = 0;
      out.data[o + 2] = 0;
      out.data[o + 3] = 255;
      continue;
    }

    if (mode === "gray") {
      const g = Math.round(((v - base) / span) * 255);
      out.data[o] = g;
      out.data[o + 1] = g;
      out.data[o + 2] = g;
    } else {
      const t = (Math.min(pHigh, Math.max(pLow, v)) - base) / span;
      out.data[o] = Math.round(Math.min(255, t * 320));
      out.data[o + 1] = Math.round(Math.min(255, t * 180));
      out.data[o + 2] = Math.round(255 - t * 200);
    }
    out.data[o + 3] = 255;
  }

  return imageDataToStep(id, title, description, out);
}

export async function drawZonesOnImage(
  id: string,
  title: string,
  description: string,
  data: ImageData,
  fractions: number[],
  highlightFraction?: number
): Promise<DetectionDebugStep> {
  const { canvas, ctx } = createCanvas(data.width, data.height);
  ctx.putImageData(data, 0, 0);

  for (const fraction of fractions) {
    const x1 = Math.round(data.width * (1 - fraction));
    const y1 = Math.round(data.height * (1 - fraction));
    const w = data.width - x1;
    const h = data.height - y1;
    const active = highlightFraction !== undefined && fraction === highlightFraction;

    ctx.fillStyle = active ? "rgba(99, 102, 241, 0.22)" : "rgba(99, 102, 241, 0.08)";
    ctx.fillRect(x1, y1, w, h);
    ctx.strokeStyle = active ? "rgba(99, 102, 241, 0.95)" : "rgba(99, 102, 241, 0.45)";
    ctx.lineWidth = active ? 3 : 2;
    ctx.setLineDash(active ? [] : [8, 6]);
    ctx.strokeRect(x1 + 0.5, y1 + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);

    ctx.fillStyle = active ? "rgba(99, 102, 241, 0.95)" : "rgba(99, 102, 241, 0.7)";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText(`${Math.round(fraction * 100)}% zone`, x1 + 8, y1 + 20);
  }

  const imageDataUrl = await canvasToDataUrl(canvas);
  return { id, title, description, width: data.width, height: data.height, imageDataUrl };
}

export async function drawMatchOnImage(
  id: string,
  title: string,
  description: string,
  data: ImageData,
  boxes: Array<{
    x: number;
    y: number;
    w: number;
    h: number;
    color?: string;
    label?: string;
    dashed?: boolean;
  }>,
  zoneFraction?: number
): Promise<DetectionDebugStep> {
  const { canvas, ctx } = createCanvas(data.width, data.height);
  ctx.putImageData(data, 0, 0);

  if (zoneFraction !== undefined) {
    const x1 = Math.round(data.width * (1 - zoneFraction));
    const y1 = Math.round(data.height * (1 - zoneFraction));
    ctx.fillStyle = "rgba(99, 102, 241, 0.1)";
    ctx.fillRect(x1, y1, data.width - x1, data.height - y1);
  }

  for (const box of boxes) {
    ctx.strokeStyle = box.color ?? "#ef4444";
    ctx.lineWidth = 3;
    ctx.setLineDash(box.dashed ? [6, 4] : []);
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);
    ctx.setLineDash([]);

    if (box.label) {
      const pad = 4;
      ctx.font = "bold 12px system-ui, sans-serif";
      const tw = ctx.measureText(box.label).width;
      const lx = box.x;
      const ly = Math.max(16, box.y - 6);
      ctx.fillStyle = box.color ?? "#ef4444";
      ctx.fillRect(lx, ly - 14, tw + pad * 2, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(box.label, lx + pad, ly);
    }
  }

  const imageDataUrl = await canvasToDataUrl(canvas);
  return { id, title, description, width: data.width, height: data.height, imageDataUrl };
}

export async function drawRegionOnNaturalImage(
  id: string,
  title: string,
  description: string,
  naturalData: ImageData,
  region: MaskRegion,
  color = "#22c55e"
): Promise<DetectionDebugStep> {
  return drawMatchOnImage(id, title, description, naturalData, [
    {
      x: region.x1,
      y: region.y1,
      w: region.width,
      h: region.height,
      color,
      label: `${Math.round(region.width)}×${Math.round(region.height)}px`,
    },
  ]);
}

export async function templateMaskToStep(
  id: string,
  title: string,
  description: string,
  mask: Float32Array,
  width: number,
  height: number
): Promise<DetectionDebugStep> {
  const out = new ImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const on = mask[i] > 0;
    const v = on ? 220 : 0;
    out.data[o] = v;
    out.data[o + 1] = v;
    out.data[o + 2] = v;
    out.data[o + 3] = 255;
  }
  return imageDataToStep(id, title, description, out);
}

export function defaultZoneDescription(): string {
  return `Primary zone: bottom-right ${Math.round(CORNER_SEARCH_FRACTION * 100)}% × ${Math.round(
    CORNER_SEARCH_FRACTION * 100
  )}%. Fallback: ${Math.round(CORNER_SEARCH_FALLBACK_FRACTION * 100)}% × ${Math.round(
    CORNER_SEARCH_FALLBACK_FRACTION * 100
  )}%.`;
}

export async function downloadDebugSteps(steps: DetectionDebugStep[]): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const comma = step.imageDataUrl.indexOf(",");
    if (comma < 0) continue;
    const base64 = step.imageDataUrl.slice(comma + 1);
    zip.file(`step${i + 1}.png`, base64, { base64: true });
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "gemini-detection-steps.zip";
  link.click();
  URL.revokeObjectURL(url);
}
