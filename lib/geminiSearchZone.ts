import type { MaskRegion } from "@/types";

/** Gemini watermark sits in Q4 (bottom-right), then Q4.4 (bottom-right of that). */
export interface GeminiSearchZone {
  midX: number;
  midY: number;
  q4MidX: number;
  q4MidY: number;
  searchRegion: MaskRegion;
}

export function getGeminiSearchZone(
  imgW: number,
  imgH: number,
  tplW = 0,
  tplH = 0
): GeminiSearchZone {
  const midX = Math.round(imgW / 2);
  const midY = Math.round(imgH / 2);
  const q4MidX = Math.round((imgW * 3) / 4);
  const q4MidY = Math.round((imgH * 3) / 4);

  const x1 = q4MidX;
  const y1 = q4MidY;
  const x2 = Math.max(x1, imgW - tplW);
  const y2 = Math.max(y1, imgH - tplH);

  return {
    midX,
    midY,
    q4MidX,
    q4MidY,
    searchRegion: {
      x1,
      y1,
      x2: tplW > 0 ? x2 : imgW,
      y2: tplH > 0 ? y2 : imgH,
      width: (tplW > 0 ? x2 : imgW) - x1,
      height: (tplH > 0 ? y2 : imgH) - y1,
    },
  };
}

export function getGeminiSearchRoi(
  imgW: number,
  imgH: number,
  tplW: number,
  tplH: number
): { x1: number; y1: number; x2: number; y2: number } {
  const { searchRegion } = getGeminiSearchZone(imgW, imgH, tplW, tplH);
  return {
    x1: searchRegion.x1,
    y1: searchRegion.y1,
    x2: searchRegion.x2,
    y2: searchRegion.y2,
  };
}
