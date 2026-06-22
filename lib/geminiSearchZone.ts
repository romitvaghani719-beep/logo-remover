import type { MaskRegion } from "@/types";

/** Primary: tight bottom-right corner (last 12% × 12%). */
export const CORNER_SEARCH_FRACTION = 0.12;

/** Fallback: wider bottom-right corner if primary finds nothing (last 18% × 18%). */
export const CORNER_SEARCH_FALLBACK_FRACTION = 0.18;

/** Tried in order — search 12% first, expand to 18% only when not found. */
export const SEARCH_ZONE_FALLBACK_CHAIN = [
  CORNER_SEARCH_FRACTION,
  CORNER_SEARCH_FALLBACK_FRACTION,
] as const;

export interface GeminiSearchZone {
  fraction: number;
  searchRegion: MaskRegion;
}

export function getGeminiSearchZone(
  imgW: number,
  imgH: number,
  tplW = 0,
  tplH = 0,
  fraction: number = CORNER_SEARCH_FRACTION
): GeminiSearchZone {
  const x1 = Math.round(imgW * (1 - fraction));
  const y1 = Math.round(imgH * (1 - fraction));
  const x2 = Math.max(x1, imgW - tplW);
  const y2 = Math.max(y1, imgH - tplH);

  return {
    fraction,
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
  tplH: number,
  fraction: number = CORNER_SEARCH_FRACTION
): { x1: number; y1: number; x2: number; y2: number } {
  const { searchRegion } = getGeminiSearchZone(imgW, imgH, tplW, tplH, fraction);
  return {
    x1: searchRegion.x1,
    y1: searchRegion.y1,
    x2: searchRegion.x2,
    y2: searchRegion.y2,
  };
}
