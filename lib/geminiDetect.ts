import type { MaskRegion } from "@/types";
import { getGeminiSearchRoi, SEARCH_ZONE_FALLBACK_CHAIN } from "@/lib/geminiSearchZone";
import {
  DetectionDebugCollector,
  type DetectionDebugMeta,
  type DetectionDebugStep,
  defaultZoneDescription,
  drawMatchOnImage,
  drawZonesOnImage,
  floatFieldToStep,
  imageDataToStep,
  templateMaskToStep,
} from "@/lib/geminiDetectDebug";

export interface GeminiDetectionResult {
  region: MaskRegion;
  confidence: number;
  scale: number;
  templateSize: number;
}

export interface GeminiDetectionDebugResult {
  result: GeminiDetectionResult | null;
  steps: DetectionDebugStep[];
  meta: DetectionDebugMeta;
}

const TEMPLATE_URLS = [
  "/templates/gemini-48.png",
  "/templates/gemini-96.png",
];

const SCALE_MULTIPLIERS = [0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 1.05, 1.15];

const MIN_SCORE = 0.38;
const MIN_RELATIVE_GAP = 1.1;
const PAD_RATIO = 0.08;
/** Tiny fixed pad on the final inpaint mask — keeps step 10 aligned with step 9. */
const FINAL_MASK_PAD_PX = 2;
const MAX_LOGO_FRACTION = 0.14;
const EXPECTED_LOGO_FRACTION = 0.08;
const TEMPLATE_SIZE_TOLERANCE = 0.5;

const COARSE_STRIDE = 4;
const FINE_STRIDE = 2;
const FINE_RADIUS = 8;
const FULL_RES_REFINE_PX = 10;
const PASS2_TOP_N = 20;
const PASS3_TOP_N = 5;

interface TemplateChannel {
  mask: Float32Array;
  norm: Float32Array;
  count: number;
}

interface PreparedTemplate {
  width: number;
  height: number;
  baseSize: number;
  scale: number;
  tightX: number;
  tightY: number;
  tightW: number;
  tightH: number;
  shape: TemplateChannel;
  edge: TemplateChannel;
  gray: TemplateChannel;
}

interface MatchCandidate {
  x: number;
  y: number;
  tpl: PreparedTemplate;
  pass2Score: number;
}

async function loadImageBitmap(url: string): Promise<ImageBitmap> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load template: ${url}`);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

function bitmapToImageData(source: ImageBitmap, width: number, height: number): ImageData {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.drawImage(source, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function buildMask(data: ImageData): { mask: Float32Array; values: Float32Array; count: number } {
  const { width, height } = data;
  const mask = new Float32Array(width * height);
  const values = new Float32Array(width * height);
  let count = 0;

  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const lum = 0.299 * data.data[o] + 0.587 * data.data[o + 1] + 0.114 * data.data[o + 2];
    const alpha = data.data[o + 3];
    if (alpha > 40 || lum > 22) {
      mask[i] = 1;
      values[i] = lum / 255;
      count++;
    }
  }

  return { mask, values, count };
}

function normalizeChannel(
  mask: Float32Array,
  values: Float32Array,
  count: number,
  width: number,
  height: number,
  mode: "gray" | "shape" | "edge"
): TemplateChannel {
  const norm = new Float32Array(width * height);
  if (count < 8) {
    return { mask, norm, count: 0 };
  }

  if (mode === "shape") {
    const unit = 1 / Math.sqrt(count);
    for (let i = 0; i < width * height; i++) {
      if (mask[i]) norm[i] = unit;
    }
    return { mask, norm, count };
  }

  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) sum += values[i];
  }
  const mean = sum / count;

  let variance = 0;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    variance += (values[i] - mean) ** 2;
  }
  const std = Math.sqrt(variance / count) || 0.001;

  for (let i = 0; i < width * height; i++) {
    if (mask[i]) norm[i] = (values[i] - mean) / std;
  }

  return { mask, norm, count };
}

function tightBoundsFromMask(
  mask: Float32Array,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, w: width, h: height };
  }

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function sobelMagnitudes(values: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const tl = values[(y - 1) * width + (x - 1)];
      const tc = values[(y - 1) * width + x];
      const tr = values[(y - 1) * width + (x + 1)];
      const ml = values[y * width + (x - 1)];
      const mr = values[y * width + (x + 1)];
      const bl = values[(y + 1) * width + (x - 1)];
      const bc = values[(y + 1) * width + x];
      const br = values[(y + 1) * width + (x + 1)];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      out[idx] = Math.hypot(gx, gy);
    }
  }
  return out;
}

function prepareTemplateFromImageData(
  data: ImageData,
  baseSize: number,
  scale: number
): PreparedTemplate {
  const { width, height } = data;
  const { mask, values, count } = buildMask(data);
  const edgeValues = sobelMagnitudes(values, width, height);
  const tight = tightBoundsFromMask(mask, width, height);

  return {
    width,
    height,
    baseSize,
    scale,
    tightX: tight.x,
    tightY: tight.y,
    tightW: tight.w,
    tightH: tight.h,
    shape: normalizeChannel(mask, values, count, width, height, "shape"),
    gray: normalizeChannel(mask, values, count, width, height, "gray"),
    edge: normalizeChannel(mask, edgeValues, count, width, height, "edge"),
  };
}

async function buildTemplates(): Promise<PreparedTemplate[]> {
  const templates: PreparedTemplate[] = [];

  for (const url of TEMPLATE_URLS) {
    const bitmap = await loadImageBitmap(url);
    const baseSize = bitmap.width;

    for (const multiplier of SCALE_MULTIPLIERS) {
      const size = Math.max(16, Math.round(baseSize * multiplier));
      const data = bitmapToImageData(bitmap, size, size);
      const prepared = prepareTemplateFromImageData(data, baseSize, multiplier);
      if (prepared.shape.count > 0) {
        templates.push(prepared);
      }
    }

    bitmap.close();
  }

  return templates.sort((a, b) => a.width - b.width);
}

function grayToUnit(gray: Float32Array): Float32Array {
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] / 255;
  return out;
}

function toGrayscale(data: ImageData): Float32Array {
  const gray = new Float32Array(data.width * data.height);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] =
      0.299 * data.data[o] + 0.587 * data.data[o + 1] + 0.114 * data.data[o + 2];
  }
  return gray;
}

function toLocalContrast(gray: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const radius = 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          sum += gray[ny * width + nx];
          n++;
        }
      }
      out[y * width + x] = gray[y * width + x] - sum / n;
    }
  }

  return out;
}

function channelScore(
  field: Float32Array,
  imgW: number,
  imgH: number,
  channel: TemplateChannel,
  tplW: number,
  tplH: number,
  x: number,
  y: number,
  useAbs = false
): number {
  const { mask, norm, count } = channel;
  if (count < 8 || x < 0 || y < 0 || x + tplW > imgW || y + tplH > imgH) return -1;

  let sum = 0;
  for (let ty = 0; ty < tplH; ty++) {
    for (let tx = 0; tx < tplW; tx++) {
      const ti = ty * tplW + tx;
      if (!mask[ti]) continue;
      sum += field[(y + ty) * imgW + (x + tx)];
    }
  }

  const mean = sum / count;
  let varP = 0;
  let ncc = 0;

  for (let ty = 0; ty < tplH; ty++) {
    for (let tx = 0; tx < tplW; tx++) {
      const ti = ty * tplW + tx;
      if (!mask[ti]) continue;
      const pv = field[(y + ty) * imgW + (x + tx)] - mean;
      varP += pv * pv;
      ncc += norm[ti] * pv;
    }
  }

  const std = Math.sqrt(varP / count) || 0.001;
  const score = ncc / (count * std);
  return useAbs ? Math.abs(score) : score;
}

function edgeOnlyScore(
  edges: Float32Array,
  imgW: number,
  imgH: number,
  tpl: PreparedTemplate,
  x: number,
  y: number
): number {
  return channelScore(edges, imgW, imgH, tpl.edge, tpl.width, tpl.height, x, y, true);
}

function edgeShapeScore(
  contrast: Float32Array,
  edges: Float32Array,
  imgW: number,
  imgH: number,
  tpl: PreparedTemplate,
  x: number,
  y: number
): number {
  const edge = channelScore(edges, imgW, imgH, tpl.edge, tpl.width, tpl.height, x, y, true);
  const shape = channelScore(contrast, imgW, imgH, tpl.shape, tpl.width, tpl.height, x, y, true);
  return Math.max(edge, shape * 0.98);
}

function combinedScore(
  gray: Float32Array,
  contrast: Float32Array,
  edges: Float32Array,
  imgW: number,
  imgH: number,
  tpl: PreparedTemplate,
  x: number,
  y: number
): number {
  const shape = channelScore(contrast, imgW, imgH, tpl.shape, tpl.width, tpl.height, x, y, true);
  const edge = channelScore(edges, imgW, imgH, tpl.edge, tpl.width, tpl.height, x, y, true);
  const lum = Math.max(
    Math.abs(channelScore(gray, imgW, imgH, tpl.gray, tpl.width, tpl.height, x, y, false)),
    Math.abs(channelScore(contrast, imgW, imgH, tpl.gray, tpl.width, tpl.height, x, y, false))
  );

  return Math.max(shape, edge * 0.98, lum * 0.92);
}

function insertTopCandidate(
  top: MatchCandidate[],
  candidate: MatchCandidate,
  limit: number
): void {
  if (candidate.pass2Score < 0) return;

  if (top.length < limit) {
    top.push(candidate);
    top.sort((a, b) => b.pass2Score - a.pass2Score);
    return;
  }

  if (candidate.pass2Score <= top[limit - 1].pass2Score) return;

  top[limit - 1] = candidate;
  top.sort((a, b) => b.pass2Score - a.pass2Score);
}

function adjustedCandidateScore(score: number, tpl: PreparedTemplate, imgMinEdge: number): number {
  const sizeRatio = tpl.tightW / (imgMinEdge * MAX_LOGO_FRACTION);
  const sizePenalty = sizeRatio > 1 ? 1 / (1 + (sizeRatio - 1) * 0.65) : 1;
  return score * sizePenalty;
}

function shouldSkipTemplateSize(tpl: PreparedTemplate, imgMinEdge: number): boolean {
  const expectedLogo = imgMinEdge * EXPECTED_LOGO_FRACTION;
  const tplSize = Math.max(tpl.tightW, tpl.tightH);
  return Math.abs(tplSize - expectedLogo) > expectedLogo * TEMPLATE_SIZE_TOLERANCE;
}

function cornerAnchoredPositions(
  imgW: number,
  imgH: number,
  tplW: number,
  tplH: number,
  roi: { x1: number; y1: number; x2: number; y2: number }
): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = [];
  const margins = [0, 3, 6, 10, 14, 18, 24, 32];
  const offsets = [-6, -3, 0, 3, 6];

  for (const margin of margins) {
    for (const dx of offsets) {
      for (const dy of offsets) {
        const x = imgW - tplW - margin + dx;
        const y = imgH - tplH - margin + dy;
        if (x < roi.x1 || y < roi.y1 || x > roi.x2 || y > roi.y2) continue;
        positions.push({ x, y });
      }
    }
  }

  return positions;
}

function searchCoarseEdgeOnly(
  edges: Float32Array,
  imgW: number,
  imgH: number,
  tpl: PreparedTemplate,
  stride: number,
  roi: { x1: number; y1: number; x2: number; y2: number }
): { score: number; x: number; y: number } {
  let bestScore = -1;
  let bestX = roi.x1;
  let bestY = roi.y1;

  for (let y = roi.y1; y <= roi.y2; y += stride) {
    for (let x = roi.x1; x <= roi.x2; x += stride) {
      const score = edgeOnlyScore(edges, imgW, imgH, tpl, x, y);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  return { score: bestScore, x: bestX, y: bestY };
}

function refineWithFullScore(
  gray: Float32Array,
  contrast: Float32Array,
  edges: Float32Array,
  imgW: number,
  imgH: number,
  candidate: MatchCandidate,
  roi: { x1: number; y1: number; x2: number; y2: number }
): { score: number; x: number; y: number } {
  const tpl = candidate.tpl;
  let bestScore = combinedScore(gray, contrast, edges, imgW, imgH, tpl, candidate.x, candidate.y);
  let bestX = candidate.x;
  let bestY = candidate.y;

  for (let y = roi.y1; y <= roi.y2; y += FINE_STRIDE) {
    for (let x = roi.x1; x <= roi.x2; x += FINE_STRIDE) {
      if (x === candidate.x && y === candidate.y) continue;
      const score = combinedScore(gray, contrast, edges, imgW, imgH, tpl, x, y);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  return { score: bestScore, x: bestX, y: bestY };
}

function candidateKey(c: MatchCandidate): string {
  return `${c.tpl.baseSize}-${c.tpl.scale}-${c.x}-${c.y}`;
}

function selectPass3Candidates(
  pool: MatchCandidate[],
  cornerGuaranteed: MatchCandidate[]
): MatchCandidate[] {
  const seen = new Set<string>();
  const pass3: MatchCandidate[] = [];

  const bestCorners = [...cornerGuaranteed].sort((a, b) => b.pass2Score - a.pass2Score);
  for (const corner of bestCorners.slice(0, 3)) {
    const key = candidateKey(corner);
    if (seen.has(key)) continue;
    seen.add(key);
    pass3.push(corner);
  }

  for (const candidate of pool) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    pass3.push(candidate);
    if (pass3.length >= PASS3_TOP_N + 3) break;
  }

  return pass3;
}

function collectPass2Candidates(
  contrast: Float32Array,
  edges: Float32Array,
  imgW: number,
  imgH: number,
  templates: PreparedTemplate[],
  tplLimit: number,
  imgMinEdge: number,
  searchFraction: number
): { pool: MatchCandidate[]; cornerGuaranteed: MatchCandidate[] } {
  const pass2Pool: MatchCandidate[] = [];
  const cornerGuaranteed: MatchCandidate[] = [];

  for (const tpl of templates) {
    if (tpl.width >= imgW || tpl.height >= imgH) continue;
    if (tpl.tightW > tplLimit || tpl.tightH > tplLimit) continue;
    if (shouldSkipTemplateSize(tpl, imgMinEdge)) continue;

    const searchRoi = getGeminiSearchRoi(imgW, imgH, tpl.width, tpl.height, searchFraction);
    if (searchRoi.x2 < searchRoi.x1 || searchRoi.y2 < searchRoi.y1) continue;

    let bestCornerEdge = -1;
    let cornerX = searchRoi.x1;
    let cornerY = searchRoi.y1;

    for (const pos of cornerAnchoredPositions(imgW, imgH, tpl.width, tpl.height, searchRoi)) {
      const edgeScore = edgeOnlyScore(edges, imgW, imgH, tpl, pos.x, pos.y);
      if (edgeScore > bestCornerEdge) {
        bestCornerEdge = edgeScore;
        cornerX = pos.x;
        cornerY = pos.y;
      }
    }

    if (bestCornerEdge >= 0) {
      cornerGuaranteed.push({
        x: cornerX,
        y: cornerY,
        tpl,
        pass2Score: edgeShapeScore(contrast, edges, imgW, imgH, tpl, cornerX, cornerY),
      });
    }

    const coarseEdge = searchCoarseEdgeOnly(edges, imgW, imgH, tpl, COARSE_STRIDE, searchRoi);
    if (coarseEdge.score >= 0) {
      insertTopCandidate(
        pass2Pool,
        {
          x: coarseEdge.x,
          y: coarseEdge.y,
          tpl,
          pass2Score: edgeShapeScore(
            contrast,
            edges,
            imgW,
            imgH,
            tpl,
            coarseEdge.x,
            coarseEdge.y
          ),
        },
        PASS2_TOP_N
      );
    }
  }

  for (const corner of cornerGuaranteed) {
    insertTopCandidate(pass2Pool, corner, PASS2_TOP_N);
  }

  return {
    pool: pass2Pool.slice(0, PASS2_TOP_N),
    cornerGuaranteed,
  };
}

function runCascadedSearch(
  gray: Float32Array,
  contrast: Float32Array,
  edges: Float32Array,
  imgW: number,
  imgH: number,
  templates: PreparedTemplate[],
  tplLimit: number,
  imgMinEdge: number,
  searchFraction: number
): {
  best: { score: number; adjusted: number; x: number; y: number; tpl: PreparedTemplate };
  secondRaw: number;
} {
  const { pool: pass2, cornerGuaranteed } = collectPass2Candidates(
    contrast,
    edges,
    imgW,
    imgH,
    templates,
    tplLimit,
    imgMinEdge,
    searchFraction
  );
  const pass3 = selectPass3Candidates(pass2, cornerGuaranteed);

  let globalBest = {
    score: -1,
    adjusted: -1,
    x: 0,
    y: 0,
    tpl: templates[0],
  };
  let globalSecondRaw = -1;

  for (const candidate of pass3) {
    const searchRoi = getGeminiSearchRoi(
      imgW,
      imgH,
      candidate.tpl.width,
      candidate.tpl.height,
      searchFraction
    );
    const fineRoi = {
      x1: Math.max(searchRoi.x1, candidate.x - FINE_RADIUS),
      y1: Math.max(searchRoi.y1, candidate.y - FINE_RADIUS),
      x2: Math.min(searchRoi.x2, candidate.x + FINE_RADIUS),
      y2: Math.min(searchRoi.y2, candidate.y + FINE_RADIUS),
    };

    const refined = refineWithFullScore(
      gray,
      contrast,
      edges,
      imgW,
      imgH,
      candidate,
      fineRoi
    );
    const adjusted = adjustedCandidateScore(refined.score, candidate.tpl, imgMinEdge);

    if (adjusted > globalBest.adjusted) {
      if (globalBest.score > globalSecondRaw) {
        globalSecondRaw = globalBest.score;
      }
      globalBest = {
        score: refined.score,
        adjusted,
        x: refined.x,
        y: refined.y,
        tpl: candidate.tpl,
      };
    } else if (refined.score > globalSecondRaw) {
      globalSecondRaw = refined.score;
    }
  }

  return { best: globalBest, secondRaw: globalSecondRaw };
}

function regionFromTightMatch(
  x: number,
  y: number,
  w: number,
  h: number,
  imgW: number,
  imgH: number
): MaskRegion {
  return regionFromBox(x, y, w, h, imgW, imgH, PAD_RATIO, FINAL_MASK_PAD_PX);
}

function regionFromDetection(
  matchX: number,
  matchY: number,
  tpl: PreparedTemplate,
  imgW: number,
  imgH: number
): MaskRegion {
  const x = Math.round(matchX + tpl.tightX);
  const y = Math.round(matchY + tpl.tightY);
  const w = tpl.tightW;
  const h = tpl.tightH;
  return regionFromTightMatch(x, y, w, h, imgW, imgH);
}

function naturalTightRegionFromSearchMatch(
  refinedMatchX: number,
  refinedMatchY: number,
  searchTpl: PreparedTemplate,
  searchScale: number,
  imgW: number,
  imgH: number
): MaskRegion {
  const inv = 1 / searchScale;
  const x = Math.round(refinedMatchX + searchTpl.tightX * inv);
  const y = Math.round(refinedMatchY + searchTpl.tightY * inv);
  const w = Math.max(8, Math.round(searchTpl.tightW * inv));
  const h = Math.max(8, Math.round(searchTpl.tightH * inv));
  return regionFromTightMatch(x, y, w, h, imgW, imgH);
}

function maxTemplateSize(imgW: number, imgH: number): number {
  return Math.max(24, Math.round(Math.min(imgW, imgH) * MAX_LOGO_FRACTION));
}

function isAcceptableScore(best: number, second: number): boolean {
  if (best < MIN_SCORE) return false;
  if (second <= 0) return true;
  return best >= second * MIN_RELATIVE_GAP || best >= 0.48;
}

function regionFromBox(
  x: number,
  y: number,
  w: number,
  h: number,
  imgW: number,
  imgH: number,
  padRatio = PAD_RATIO,
  fixedPadPx?: number
): MaskRegion {
  const padX = fixedPadPx !== undefined ? fixedPadPx : Math.round(w * padRatio);
  const padY = fixedPadPx !== undefined ? fixedPadPx : Math.round(h * padRatio);
  const x1 = Math.max(0, x - padX);
  const y1 = Math.max(0, y - padY);
  const x2 = Math.min(imgW, x + w + padX);
  const y2 = Math.min(imgH, y + h + padY);

  return {
    x1,
    y1,
    x2,
    y2,
    width: x2 - x1,
    height: y2 - y1,
  };
}

let templatesCache: PreparedTemplate[] | null = null;
let templatesCacheVersion = 0;
const TEMPLATE_CACHE_VERSION = 6;

async function getTemplates() {
  if (!templatesCache || templatesCacheVersion !== TEMPLATE_CACHE_VERSION) {
    templatesCache = await buildTemplates();
    templatesCacheVersion = TEMPLATE_CACHE_VERSION;
  }
  return templatesCache;
}

async function pushDebug(
  debug: DetectionDebugCollector | undefined,
  step: Promise<DetectionDebugStep>
): Promise<void> {
  if (!debug) return;
  debug.add(await step);
}

export async function detectGeminiLogo(
  imageSource: Blob | File,
  debug?: DetectionDebugCollector
): Promise<GeminiDetectionResult | null> {
  const [bitmap, templates] = await Promise.all([
    createImageBitmap(imageSource),
    getTemplates(),
  ]);

  const naturalW = bitmap.width;
  const naturalH = bitmap.height;
  const maxSearchEdge = 1600;
  const searchScale = Math.min(1, maxSearchEdge / Math.max(naturalW, naturalH));
  const searchW = Math.max(1, Math.round(naturalW * searchScale));
  const searchH = Math.max(1, Math.round(naturalH * searchScale));

  const naturalData = bitmapToImageData(bitmap, naturalW, naturalH);
  await pushDebug(
    debug,
    imageDataToStep(
      "01-original",
      "1. Original image",
      `Full resolution input (${naturalW}×${naturalH}px).`,
      naturalData
    )
  );

  const searchData = bitmapToImageData(bitmap, searchW, searchH);
  await pushDebug(
    debug,
    imageDataToStep(
      "02-search-scale",
      "2. Search-scale image",
      searchScale < 0.99
        ? `Downscaled to ${searchW}×${searchH}px (scale ${searchScale.toFixed(3)}) for faster template matching.`
        : `Used at full resolution (${searchW}×${searchH}px).`,
      searchData
    )
  );

  const gray = toGrayscale(searchData);
  const contrast = toLocalContrast(gray, searchW, searchH);
  const edges = sobelMagnitudes(grayToUnit(gray), searchW, searchH);
  const tplLimit = maxTemplateSize(searchW, searchH);
  const imgMinEdge = Math.min(searchW, searchH);

  await pushDebug(
    debug,
    floatFieldToStep(
      "03-grayscale",
      "3. Grayscale",
      "Luminance map used for brightness matching.",
      gray,
      searchW,
      searchH,
      "gray"
    )
  );
  await pushDebug(
    debug,
    floatFieldToStep(
      "04-local-contrast",
      "4. Local contrast",
      "Highlights sparkle-like shapes independent of background color.",
      contrast,
      searchW,
      searchH,
      "heatmap"
    )
  );
  await pushDebug(
    debug,
    floatFieldToStep(
      "05-sobel-edges",
      "5. Sobel edges",
      "Edge map used for coarse corner scan (Pass 2).",
      edges,
      searchW,
      searchH,
      "heatmap"
    )
  );
  await pushDebug(
    debug,
    drawZonesOnImage(
      "06-search-zones",
      "6. Search zones",
      defaultZoneDescription(),
      searchData,
      [...SEARCH_ZONE_FALLBACK_CHAIN]
    )
  );

  let globalBest: {
    score: number;
    adjusted: number;
    x: number;
    y: number;
    tpl: PreparedTemplate;
  } | null = null;
  let globalSecondRaw = -1;
  let matchedFraction: number = SEARCH_ZONE_FALLBACK_CHAIN[0];
  let triedFractions: number[] = [];

  for (const fraction of SEARCH_ZONE_FALLBACK_CHAIN) {
    triedFractions.push(fraction);
    const result = runCascadedSearch(
      gray,
      contrast,
      edges,
      searchW,
      searchH,
      templates,
      tplLimit,
      imgMinEdge,
      fraction
    );

    if (isAcceptableScore(result.best.score, result.secondRaw)) {
      globalBest = result.best;
      globalSecondRaw = result.secondRaw;
      matchedFraction = fraction;
      break;
    }
  }

  if (!globalBest || !isAcceptableScore(globalBest.score, globalSecondRaw)) {
    if (debug) {
      debug.meta = {
        naturalWidth: naturalW,
        naturalHeight: naturalH,
        searchWidth: searchW,
        searchHeight: searchH,
        searchScale,
        matchedZoneFraction: null,
        found: false,
        confidence: globalBest?.score ?? null,
        templateSize: null,
        region: null,
      };
      await pushDebug(
        debug,
        drawZonesOnImage(
          "07-no-match",
          "7. No confident match",
          globalBest
            ? `Best score ${(globalBest.score * 100).toFixed(0)}% was below threshold (${(MIN_SCORE * 100).toFixed(0)}%) or too close to runner-up.`
            : "No template produced a valid match inside the search zones.",
          searchData,
          triedFractions,
          triedFractions[triedFractions.length - 1]
        )
      );
    }
    bitmap.close();
    return null;
  }

  const bestTpl = globalBest.tpl;
  await pushDebug(
    debug,
    templateMaskToStep(
      "07-template",
      "7. Matched template",
      `Base ${bestTpl.baseSize}px template at scale ${bestTpl.scale.toFixed(2)} (${bestTpl.width}×${bestTpl.height}px).`,
      bestTpl.shape.mask,
      bestTpl.width,
      bestTpl.height
    )
  );
  await pushDebug(
    debug,
    drawMatchOnImage(
      "08-coarse-match",
      "8. Coarse + fine match (search scale)",
      `Score ${(globalBest.score * 100).toFixed(0)}% in ${Math.round(matchedFraction * 100)}% corner zone. Red = template bounds; dashed = tight logo shape.`,
      searchData,
      [
        {
          x: globalBest.x,
          y: globalBest.y,
          w: bestTpl.width,
          h: bestTpl.height,
          color: "#3b82f6",
          label: `match ${(globalBest.score * 100).toFixed(0)}%`,
        },
        {
          x: globalBest.x + bestTpl.tightX,
          y: globalBest.y + bestTpl.tightY,
          w: bestTpl.tightW,
          h: bestTpl.tightH,
          color: "#ef4444",
          label: "logo",
          dashed: true,
        },
      ],
      matchedFraction
    )
  );

  let finalX = Math.round(globalBest.x / searchScale);
  let finalY = Math.round(globalBest.y / searchScale);
  let finalTpl = globalBest.tpl;
  const searchMatchTpl = globalBest.tpl;
  let finalScore = globalBest.score;

  if (searchScale < 0.99) {
    const fullData = bitmapToImageData(bitmap, naturalW, naturalH);
    const fullGray = toGrayscale(fullData);
    const fullContrast = toLocalContrast(fullGray, naturalW, naturalH);
    const fullEdges = sobelMagnitudes(grayToUnit(fullGray), naturalW, naturalH);
    const fullTplSize = Math.max(16, Math.round(globalBest.tpl.width / searchScale));
    const baseUrl =
      globalBest.tpl.baseSize === 48 ? TEMPLATE_URLS[0] : TEMPLATE_URLS[1];
    const baseBitmap = await loadImageBitmap(baseUrl);
    const fullTpl = prepareTemplateFromImageData(
      bitmapToImageData(baseBitmap, fullTplSize, fullTplSize),
      globalBest.tpl.baseSize,
      globalBest.tpl.scale
    );
    baseBitmap.close();

    if (fullTpl.shape.count > 0 && fullTpl.width < naturalW && fullTpl.height < naturalH) {
      const zoneRoi = getGeminiSearchRoi(
        naturalW,
        naturalH,
        fullTpl.width,
        fullTpl.height,
        matchedFraction
      );
      const roi = {
        x1: Math.max(zoneRoi.x1, finalX - FULL_RES_REFINE_PX),
        y1: Math.max(zoneRoi.y1, finalY - FULL_RES_REFINE_PX),
        x2: Math.min(zoneRoi.x2, finalX + FULL_RES_REFINE_PX),
        y2: Math.min(zoneRoi.y2, finalY + FULL_RES_REFINE_PX),
      };

      if (roi.x2 >= roi.x1 && roi.y2 >= roi.y1) {
        const refined = refineWithFullScore(
          fullGray,
          fullContrast,
          fullEdges,
          naturalW,
          naturalH,
          { x: finalX, y: finalY, tpl: fullTpl, pass2Score: finalScore },
          roi
        );
        await pushDebug(
          debug,
          drawMatchOnImage(
            "09-full-res-refine",
            "9. Full-resolution refine",
            `Re-scored within ±${FULL_RES_REFINE_PX}px on original pixels. Score ${(refined.score * 100).toFixed(0)}%.`,
            fullData,
            [
              {
                x: roi.x1,
                y: roi.y1,
                w: roi.x2 - roi.x1 + 1,
                h: roi.y2 - roi.y1 + 1,
                color: "#a855f7",
                label: "refine window",
                dashed: true,
              },
              {
                x: refined.x + Math.round(searchMatchTpl.tightX / searchScale),
                y: refined.y + Math.round(searchMatchTpl.tightY / searchScale),
                w: Math.max(8, Math.round(searchMatchTpl.tightW / searchScale)),
                h: Math.max(8, Math.round(searchMatchTpl.tightH / searchScale)),
                color: "#ef4444",
                label: "tight logo",
                dashed: true,
              },
              {
                x: refined.x,
                y: refined.y,
                w: fullTpl.width,
                h: fullTpl.height,
                color: "#22c55e",
                label: `refined ${(refined.score * 100).toFixed(0)}%`,
              },
            ],
            matchedFraction
          )
        );
        if (refined.score >= finalScore * 0.82) {
          finalX = refined.x;
          finalY = refined.y;
          finalTpl = fullTpl;
          finalScore = refined.score;
        }
      }
    }
  }

  const region =
    searchScale < 0.99
      ? naturalTightRegionFromSearchMatch(
          finalX,
          finalY,
          searchMatchTpl,
          searchScale,
          naturalW,
          naturalH
        )
      : regionFromDetection(finalX, finalY, finalTpl, naturalW, naturalH);

  const inv = 1 / searchScale;
  const tightX =
    searchScale < 0.99
      ? Math.round(finalX + searchMatchTpl.tightX * inv)
      : Math.round(finalX + finalTpl.tightX);
  const tightY =
    searchScale < 0.99
      ? Math.round(finalY + searchMatchTpl.tightY * inv)
      : Math.round(finalY + finalTpl.tightY);
  const tightW =
    searchScale < 0.99
      ? Math.max(8, Math.round(searchMatchTpl.tightW * inv))
      : finalTpl.tightW;
  const tightH =
    searchScale < 0.99
      ? Math.max(8, Math.round(searchMatchTpl.tightH * inv))
      : finalTpl.tightH;

  await pushDebug(
    debug,
    drawMatchOnImage(
      "10-final-mask",
      "10. Final mask region",
      `Same tight bounds as step 9 + ${FINAL_MASK_PAD_PX}px pad (${Math.round(region.width)}×${Math.round(region.height)}px, confidence ${(finalScore * 100).toFixed(0)}%).`,
      naturalData,
      [
        {
          x: tightX,
          y: tightY,
          w: tightW,
          h: tightH,
          color: "#ef4444",
          label: "tight logo",
          dashed: true,
        },
        {
          x: region.x1,
          y: region.y1,
          w: region.width,
          h: region.height,
          color: "#22c55e",
          label: `${Math.round(region.width)}×${Math.round(region.height)}px`,
        },
      ],
      matchedFraction
    )
  );

  if (debug) {
    debug.meta = {
      naturalWidth: naturalW,
      naturalHeight: naturalH,
      searchWidth: searchW,
      searchHeight: searchH,
      searchScale,
      matchedZoneFraction: matchedFraction,
      found: true,
      confidence: finalScore,
      templateSize: finalTpl.baseSize,
      region,
    };
  }

  bitmap.close();

  return {
    region,
    confidence: finalScore,
    scale: finalTpl.scale,
    templateSize: finalTpl.baseSize,
  };
}

export async function detectGeminiLogoWithDebug(
  imageSource: Blob | File
): Promise<GeminiDetectionDebugResult> {
  const debug = new DetectionDebugCollector();
  const result = await detectGeminiLogo(imageSource, debug);
  return {
    result,
    steps: debug.steps,
    meta: {
      naturalWidth: debug.meta.naturalWidth ?? 0,
      naturalHeight: debug.meta.naturalHeight ?? 0,
      searchWidth: debug.meta.searchWidth ?? 0,
      searchHeight: debug.meta.searchHeight ?? 0,
      searchScale: debug.meta.searchScale ?? 1,
      matchedZoneFraction: debug.meta.matchedZoneFraction ?? null,
      found: debug.meta.found ?? Boolean(result),
      confidence: debug.meta.confidence ?? result?.confidence ?? null,
      templateSize: debug.meta.templateSize ?? result?.templateSize ?? null,
      region: debug.meta.region ?? result?.region ?? null,
    },
  };
}

export function clearGeminiTemplateCache() {
  templatesCache = null;
  templatesCacheVersion = 0;
}
