import type { ClickPoint, MaskRegion } from "@/types";

export interface RenderedImageBounds {
  offsetX: number;
  offsetY: number;
  renderedWidth: number;
  renderedHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}

/** Image stage uses a wrapper sized exactly to the img — no letterbox offsets needed. */
export function getImageStageBounds(img: HTMLImageElement): RenderedImageBounds {
  return {
    offsetX: 0,
    offsetY: 0,
    renderedWidth: img.clientWidth,
    renderedHeight: img.clientHeight,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  };
}

export function clientToImagePoint(
  clientX: number,
  clientY: number,
  stageEl: HTMLElement,
  bounds: RenderedImageBounds
): ClickPoint | null {
  const rect = stageEl.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;

  if (
    localX < 0 ||
    localX > bounds.renderedWidth ||
    localY < 0 ||
    localY > bounds.renderedHeight
  ) {
    return null;
  }

  return {
    x: (localX / bounds.renderedWidth) * bounds.naturalWidth,
    y: (localY / bounds.renderedHeight) * bounds.naturalHeight,
  };
}

export function imageToDisplayRect(region: MaskRegion, bounds: RenderedImageBounds) {
  const scaleX = bounds.renderedWidth / bounds.naturalWidth;
  const scaleY = bounds.renderedHeight / bounds.naturalHeight;

  return {
    left: region.x1 * scaleX,
    top: region.y1 * scaleY,
    width: region.width * scaleX,
    height: region.height * scaleY,
  };
}

export function regionFromPoints(a: ClickPoint, b: ClickPoint): MaskRegion {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x, b.x);
  const y2 = Math.max(a.y, b.y);
  return {
    x1,
    y1,
    x2,
    y2,
    width: x2 - x1,
    height: y2 - y1,
  };
}

export function clampRegion(
  region: MaskRegion,
  imageWidth: number,
  imageHeight: number
): MaskRegion {
  const width = Math.min(region.width, imageWidth);
  const height = Math.min(region.height, imageHeight);
  const x1 = Math.max(0, Math.min(region.x1, imageWidth - width));
  const y1 = Math.max(0, Math.min(region.y1, imageHeight - height));
  return {
    x1,
    y1,
    x2: x1 + width,
    y2: y1 + height,
    width,
    height,
  };
}

export function displayDeltaToImageDelta(
  dx: number,
  dy: number,
  bounds: RenderedImageBounds
) {
  return {
    dx: dx * (bounds.naturalWidth / bounds.renderedWidth),
    dy: dy * (bounds.naturalHeight / bounds.renderedHeight),
  };
}

export function imageBrushRadius(brushSizeDisplay: number, bounds: RenderedImageBounds) {
  const scale = bounds.naturalWidth / bounds.renderedWidth;
  return Math.max(4, (brushSizeDisplay / 2) * scale);
}

export function createEmptyMaskCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  }
  return { canvas, ctx };
}

export function drawRegionOnMask(
  ctx: CanvasRenderingContext2D,
  region: MaskRegion
) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(region.x1, region.y1, region.width, region.height);
}

export function paintBrushStrokeDisplay(
  ctx: CanvasRenderingContext2D,
  from: ClickPoint,
  to: ClickPoint,
  radius: number,
  bounds: RenderedImageBounds,
  color = "rgba(239, 68, 68, 0.55)"
) {
  const scaleX = bounds.renderedWidth / bounds.naturalWidth;
  const scaleY = bounds.renderedHeight / bounds.naturalHeight;
  const sx = from.x * scaleX;
  const sy = from.y * scaleY;
  const ex = to.x * scaleX;
  const ey = to.y * scaleY;
  const r = radius * scaleX;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = r * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ex, ey, r, 0, Math.PI * 2);
  ctx.fill();
}

export function syncBrushOverlayFromMask(
  maskCtx: CanvasRenderingContext2D,
  overlayCtx: CanvasRenderingContext2D
) {
  const w = overlayCtx.canvas.width;
  const h = overlayCtx.canvas.height;
  overlayCtx.clearRect(0, 0, w, h);

  const mw = maskCtx.canvas.width;
  const mh = maskCtx.canvas.height;
  const src = maskCtx.getImageData(0, 0, mw, mh).data;
  const scaleX = mw / w;
  const scaleY = mh / h;

  overlayCtx.fillStyle = "rgba(239, 68, 68, 0.55)";

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mw - 1, Math.floor(x * scaleX));
      const sy = Math.min(mh - 1, Math.floor(y * scaleY));
      const i = (sy * mw + sx) * 4;
      if (src[i] > 128) {
        overlayCtx.fillRect(x, y, 1, 1);
      }
    }
  }
}

export function paintBrushStroke(
  ctx: CanvasRenderingContext2D,
  from: ClickPoint,
  to: ClickPoint,
  radius: number
) {
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = radius * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(to.x, to.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

export function maskHasContent(ctx: CanvasRenderingContext2D): boolean {
  const { data } = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 10) return true;
  }
  return false;
}

export function maskCanvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

export function regionCenter(region: MaskRegion): ClickPoint {
  return {
    x: region.x1 + region.width / 2,
    y: region.y1 + region.height / 2,
  };
}
