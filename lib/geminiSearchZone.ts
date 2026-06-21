import type { MaskRegion } from "@/types";

/** Gemini watermark sits in the bottom-right corner (last 12% × 12%). */
export const CORNER_SEARCH_FRACTION = 0.12;

export interface GeminiSearchZone {
  searchRegion: MaskRegion;
}

export function getGeminiSearchZone(
  imgW: number,
  imgH: number,
  tplW = 0,
  tplH = 0
): GeminiSearchZone {
  const x1 = Math.round(imgW * (1 - CORNER_SEARCH_FRACTION));
  const y1 = Math.round(imgH * (1 - CORNER_SEARCH_FRACTION));
  const x2 = Math.max(x1, imgW - tplW);
  const y2 = Math.max(y1, imgH - tplH);

  return {
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
