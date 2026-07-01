import { detectGeminiLogo } from "@/lib/geminiDetectClient";
import type { GeminiDetectionResult } from "@/lib/geminiDetect";
import {
  applyAlphaRemoval,
  loadImageSource,
  regionToMaskBlob,
  regionsToCombinedMaskBlob,
} from "@/lib/alphaBlend";
import { removeLogo as inpaintLogo } from "@/lib/inpaintClient";
import {
  getWatermarkFallbackProfiles,
  profileLogoRect,
  type WatermarkProfile,
} from "@/lib/watermarkProfiles";
import type { MaskRegion } from "@/types";

/** Use reverse alpha blending when detection confidence is at or above this. */
export const ALPHA_CONFIDENCE_THRESHOLD = 0.7;

/** Minimum score to treat a logo as still present after removal. */
export const RESIDUAL_DETECTION_THRESHOLD = 0.28;

export const MAX_REMOVAL_PASSES = 4;

export type RemovalMethod = "alpha" | "inpaint";

export interface RemovalPassLog {
  pass: number;
  method: RemovalMethod;
  reason: string;
  confidence?: number;
  region?: MaskRegion;
}

export interface HybridRemovalResult {
  blob: Blob;
  passes: RemovalPassLog[];
  finalDetection: GeminiDetectionResult | null;
  clean: boolean;
}

function blobToFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type || "image/png" });
}

function logoRectFromDetection(detection: GeminiDetectionResult): MaskRegion {
  const logoSize = detection.templateSize;
  const padX = Math.max(0, Math.round((detection.region.width - logoSize) / 2));
  const padY = Math.max(0, Math.round((detection.region.height - logoSize) / 2));
  return {
    x1: detection.region.x1 + padX,
    y1: detection.region.y1 + padY,
    x2: detection.region.x1 + padX + logoSize,
    y2: detection.region.y1 + padY + logoSize,
    width: logoSize,
    height: logoSize,
  };
}

async function runAlphaAtDetection(
  imageBlob: Blob,
  detection: GeminiDetectionResult,
  profile: WatermarkProfile
): Promise<Blob> {
  const logoRect = logoRectFromDetection(detection);
  return applyAlphaRemoval(
    imageBlob,
    logoRect,
    profile.alphaSourceSize,
    detection.templateSize
  );
}

async function runAlphaAtProfile(
  imageBlob: Blob,
  profile: WatermarkProfile
): Promise<Blob> {
  const logoRect = profileLogoRect(profile);
  return applyAlphaRemoval(
    imageBlob,
    logoRect,
    profile.alphaSourceSize,
    profile.logoSize
  );
}

async function runAlphaAtBothFallbacks(
  imageBlob: Blob,
  profiles: WatermarkProfile[]
): Promise<Blob> {
  let current = imageBlob;
  for (const profile of profiles) {
    current = await runAlphaAtProfile(current, profile);
  }
  return current;
}

async function runInpaintAtRegion(
  imageBlob: Blob,
  imgW: number,
  imgH: number,
  region: MaskRegion,
  featherPx: number
): Promise<Blob> {
  const mask = await regionToMaskBlob(imgW, imgH, region);
  return inpaintLogo(blobToFile(imageBlob, "frame.png"), mask, featherPx);
}

async function runInpaintAtRegions(
  imageBlob: Blob,
  imgW: number,
  imgH: number,
  regions: MaskRegion[],
  featherPx: number
): Promise<Blob> {
  const mask = await regionsToCombinedMaskBlob(imgW, imgH, regions);
  return inpaintLogo(blobToFile(imageBlob, "frame.png"), mask, featherPx);
}

function pickProfileForDetection(
  imgW: number,
  imgH: number,
  templateSize: number
): WatermarkProfile {
  const profiles = getWatermarkFallbackProfiles(imgW, imgH);
  const bySize = profiles.find((p) => p.logoSize === templateSize);
  return bySize ?? profiles[0];
}

function combinedFallbackRegion(profiles: WatermarkProfile[]): MaskRegion {
  const x1 = Math.min(...profiles.map((p) => p.region.x1));
  const y1 = Math.min(...profiles.map((p) => p.region.y1));
  const x2 = Math.max(...profiles.map((p) => p.region.x2));
  const y2 = Math.max(...profiles.map((p) => p.region.y2));
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

export interface HybridRemovalOptions {
  imageFile: File;
  featherPx: number;
  maskBlob?: Blob | null;
  manualRegion?: MaskRegion | null;
  initialDetection?: GeminiDetectionResult | null;
  selectedFallback?: WatermarkProfile | null;
  fallbackProfiles?: WatermarkProfile[];
  onPass?: (log: RemovalPassLog) => void;
}

export async function runHybridRemoval(
  options: HybridRemovalOptions
): Promise<HybridRemovalResult> {
  const {
    imageFile,
    featherPx,
    maskBlob,
    manualRegion,
    initialDetection,
    selectedFallback,
    fallbackProfiles: fallbackProfilesIn,
    onPass,
  } = options;

  const img = await loadImageSource(imageFile);
  const imgW = img.naturalWidth;
  const imgH = img.naturalHeight;
  const fallbackProfiles =
    fallbackProfilesIn ?? getWatermarkFallbackProfiles(imgW, imgH);

  let currentBlob: Blob = imageFile;
  const passes: RemovalPassLog[] = [];
  const hasManualMask = Boolean(maskBlob && manualRegion);
  let usedDualFallback = false;

  for (let pass = 0; pass < MAX_REMOVAL_PASSES; pass++) {
    const detection =
      pass === 0 && initialDetection !== undefined
        ? initialDetection
        : await detectGeminiLogo(blobToFile(currentBlob, imageFile.name));

    let method: RemovalMethod | null = null;
    let region: MaskRegion | null = null;
    let reason = "";
    let profile: WatermarkProfile | undefined;
    let inpaintRegions: MaskRegion[] | null = null;

    if (pass === 0) {
      if (detection && detection.confidence >= ALPHA_CONFIDENCE_THRESHOLD) {
        method = "alpha";
        region = detection.region;
        profile = pickProfileForDetection(imgW, imgH, detection.templateSize);
        reason = `High confidence (${(detection.confidence * 100).toFixed(0)}%) — reverse alpha blend`;
      } else if (selectedFallback) {
        method = "inpaint";
        region = selectedFallback.region;
        profile = selectedFallback;
        reason = `${selectedFallback.label} fallback — LaMa inpaint`;
      } else if (hasManualMask && manualRegion) {
        method = "inpaint";
        region = manualRegion;
        reason = "Manual selection — LaMa inpaint";
      } else if (detection && detection.confidence >= RESIDUAL_DETECTION_THRESHOLD) {
        method = "inpaint";
        region = detection.region;
        reason = `Detected ${(detection.confidence * 100).toFixed(0)}% — LaMa inpaint`;
      } else if (fallbackProfiles.length > 0) {
        method = "inpaint";
        inpaintRegions = fallbackProfiles.map((p) => p.region);
        region = combinedFallbackRegion(fallbackProfiles);
        usedDualFallback = true;
        reason = `No logo detected — LaMa inpaint at V1 + V2 fallback zones (${fallbackProfiles.length} areas)`;
      } else {
        break;
      }
    } else {
      if (!detection || detection.confidence < RESIDUAL_DETECTION_THRESHOLD) {
        break;
      }

      profile = pickProfileForDetection(imgW, imgH, detection.templateSize);
      method = "alpha";
      region = detection.region;
      reason = `Residual logo ${(detection.confidence * 100).toFixed(0)}% — reverse alpha blend (pass ${pass + 1})`;
    }

    if (!method || !region) break;

    const log: RemovalPassLog = {
      pass: pass + 1,
      method,
      reason,
      confidence: detection?.confidence,
      region,
    };
    passes.push(log);
    onPass?.(log);

    if (method === "alpha" && detection && profile) {
      currentBlob = await runAlphaAtDetection(currentBlob, detection, profile);
    } else if (method === "alpha" && profile) {
      currentBlob = await runAlphaAtProfile(currentBlob, profile);
    } else if (inpaintRegions && inpaintRegions.length > 1) {
      currentBlob = await runInpaintAtRegions(
        currentBlob,
        imgW,
        imgH,
        inpaintRegions,
        featherPx
      );
    } else {
      currentBlob = await runInpaintAtRegion(currentBlob, imgW, imgH, region, featherPx);
    }
  }

  let finalDetection = await detectGeminiLogo(blobToFile(currentBlob, imageFile.name));

  if (
    finalDetection &&
    finalDetection.confidence >= RESIDUAL_DETECTION_THRESHOLD &&
    passes.length < MAX_REMOVAL_PASSES
  ) {
    const profile = pickProfileForDetection(imgW, imgH, finalDetection.templateSize);
    const log: RemovalPassLog = {
      pass: passes.length + 1,
      method: "alpha",
      reason: `Post-check: logo still ${(finalDetection.confidence * 100).toFixed(0)}% — alpha at detection`,
      confidence: finalDetection.confidence,
      region: finalDetection.region,
    };
    passes.push(log);
    onPass?.(log);
    currentBlob = await runAlphaAtDetection(currentBlob, finalDetection, profile);
    finalDetection = await detectGeminiLogo(blobToFile(currentBlob, imageFile.name));
  }

  if (
    finalDetection &&
    finalDetection.confidence >= RESIDUAL_DETECTION_THRESHOLD &&
    usedDualFallback &&
    passes.length < MAX_REMOVAL_PASSES
  ) {
    const log: RemovalPassLog = {
      pass: passes.length + 1,
      method: "alpha",
      reason: `Post-check: logo still ${(finalDetection.confidence * 100).toFixed(0)}% — alpha at V1 + V2 fallbacks`,
      confidence: finalDetection.confidence,
      region: combinedFallbackRegion(fallbackProfiles),
    };
    passes.push(log);
    onPass?.(log);
    currentBlob = await runAlphaAtBothFallbacks(currentBlob, fallbackProfiles);
    finalDetection = await detectGeminiLogo(blobToFile(currentBlob, imageFile.name));
  }

  const clean =
    !finalDetection || finalDetection.confidence < RESIDUAL_DETECTION_THRESHOLD;

  return {
    blob: currentBlob,
    passes,
    finalDetection,
    clean,
  };
}

export function getPlannedRemovalMode(
  confidence: number | null
): "alpha" | "inpaint" | "dual-fallback" {
  if (confidence !== null && confidence >= ALPHA_CONFIDENCE_THRESHOLD) return "alpha";
  if (confidence !== null && confidence >= RESIDUAL_DETECTION_THRESHOLD) return "inpaint";
  return "dual-fallback";
}
