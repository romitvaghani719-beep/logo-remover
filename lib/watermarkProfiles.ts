import type { MaskRegion } from "@/types";

export type WatermarkVariant = "v1" | "v2";

export interface WatermarkProfile {
  id: string;
  label: string;
  variant: WatermarkVariant;
  logoSize: number;
  marginRight: number;
  marginBottom: number;
  region: MaskRegion;
  /** Source alpha capture size (48 or 96 before any resize). */
  alphaSourceSize: 48 | 96;
}

function regionFromPosition(
  imgW: number,
  imgH: number,
  logoSize: number,
  marginRight: number,
  marginBottom: number,
  padPx = 2
): MaskRegion {
  const x = imgW - marginRight - logoSize;
  const y = imgH - marginBottom - logoSize;
  const x1 = Math.max(0, x - padPx);
  const y1 = Math.max(0, y - padPx);
  const x2 = Math.min(imgW, x + logoSize + padPx);
  const y2 = Math.min(imgH, y + logoSize + padPx);
  return {
    x1,
    y1,
    x2,
    y2,
    width: x2 - x1,
    height: y2 - y1,
  };
}

/** V2 small margin from aspect ratio (GeminiWatermarkTool logic). */
function v2SmallMargin(imgW: number, imgH: number): number {
  const longSide = Math.max(imgW, imgH);
  const shortSide = Math.min(imgW, imgH);
  let sourceLongDim: number;
  if (shortSide >= 566) sourceLongDim = 2752;
  else if (shortSide >= 550) sourceLongDim = 2816;
  else sourceLongDim = 2848;
  const scale = longSide / sourceLongDim;
  return Math.round(192 * scale);
}

function v1Profile(imgW: number, imgH: number): WatermarkProfile {
  const isLarge = imgW > 1024 && imgH > 1024;
  const logoSize = isLarge ? 96 : 48;
  const margin = isLarge ? 64 : 32;
  return {
    id: "v1",
    label: isLarge ? "V1 legacy · 96×96" : "V1 legacy · 48×48",
    variant: "v1",
    logoSize,
    marginRight: margin,
    marginBottom: margin,
    region: regionFromPosition(imgW, imgH, logoSize, margin, margin),
    alphaSourceSize: isLarge ? 96 : 48,
  };
}

function v2Profile(imgW: number, imgH: number): WatermarkProfile {
  const isLarge = imgW > 1024 && imgH > 1024;
  if (isLarge) {
    const logoSize = 96;
    const margin = 192;
    return {
      id: "v2",
      label: "V2 Gemini 3.5+ · 96×96",
      variant: "v2",
      logoSize,
      marginRight: margin,
      marginBottom: margin,
      region: regionFromPosition(imgW, imgH, logoSize, margin, margin),
      alphaSourceSize: 96,
    };
  }

  const logoSize = 36;
  const margin = v2SmallMargin(imgW, imgH);
  return {
    id: "v2",
    label: "V2 Gemini 3.5+ · 36×36",
    variant: "v2",
    logoSize,
    marginRight: margin,
    marginBottom: margin,
    region: regionFromPosition(imgW, imgH, logoSize, margin, margin),
    alphaSourceSize: 96,
  };
}

/** Both GWT-style positional fallbacks for the given image size. */
export function getWatermarkFallbackProfiles(imgW: number, imgH: number): WatermarkProfile[] {
  return [v1Profile(imgW, imgH), v2Profile(imgW, imgH)];
}

export function profileLogoRect(profile: WatermarkProfile): MaskRegion {
  const { region, logoSize } = profile;
  const padX = region.width - logoSize;
  const padY = region.height - logoSize;
  const halfPadX = Math.max(0, Math.floor(padX / 2));
  const halfPadY = Math.max(0, Math.floor(padY / 2));
  return {
    x1: region.x1 + halfPadX,
    y1: region.y1 + halfPadY,
    x2: region.x1 + halfPadX + logoSize,
    y2: region.y1 + halfPadY + logoSize,
    width: logoSize,
    height: logoSize,
  };
}
