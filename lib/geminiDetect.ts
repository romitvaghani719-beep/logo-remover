import type { MaskRegion } from "@/types";
import { getGeminiSearchRoi, getGeminiSearchZone } from "@/lib/geminiSearchZone";

export interface GeminiDetectionResult {
  region: MaskRegion;
  confidence: number;
  scale: number;
  templateSize: number;
}

const TEMPLATE_URLS = [
  "/templates/gemini-48.png",
  "/templates/gemini-96.png",
];

/** Extra scale multipliers applied to each base template (48px and 96px). */
const SCALE_MULTIPLIERS = [
  0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
  1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.65, 1.8, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0, 4.5, 5.0,
];

const MIN_SCORE = 0.52;
const PAD_RATIO = 0.15;

interface PreparedTemplate {
  width: number;
  height: number;
  mask: Float32Array;
  norm: Float32Array;
  count: number;
  baseSize: number;
  scale: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load template: ${url}`));
    img.src = url;
  });
}

function imageToImageData(img: HTMLImageElement, width: number, height: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function prepareTemplateFromImageData(data: ImageData, baseSize: number, scale: number): PreparedTemplate {
  const { width, height } = data;
  const mask = new Float32Array(width * height);
  const values = new Float32Array(width * height);
  let count = 0;
  let sum = 0;

  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const lum = 0.299 * data.data[o] + 0.587 * data.data[o + 1] + 0.114 * data.data[o + 2];
    if (lum > 22) {
      mask[i] = 1;
      values[i] = lum / 255;
      sum += values[i];
      count++;
    }
  }

  if (count < 8) {
    return { width, height, mask, norm: new Float32Array(width * height), count: 0, baseSize, scale };
  }

  const mean = sum / count;
  let variance = 0;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    variance += (values[i] - mean) ** 2;
  }
  const std = Math.sqrt(variance / count) || 0.001;

  const norm = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) norm[i] = (values[i] - mean) / std;
  }

  return { width, height, mask, norm, count, baseSize, scale };
}

async function buildTemplates(): Promise<PreparedTemplate[]> {
  const templates: PreparedTemplate[] = [];

  for (const url of TEMPLATE_URLS) {
    const img = await loadImage(url);
    const baseSize = img.naturalWidth;

    for (const multiplier of SCALE_MULTIPLIERS) {
      const size = Math.max(16, Math.round(baseSize * multiplier));
      const data = imageToImageData(img, size, size);
      const prepared = prepareTemplateFromImageData(data, baseSize, multiplier);
      if (prepared.count > 0) {
        templates.push(prepared);
      }
    }
  }

  return templates.sort((a, b) => a.width - b.width);
}

function fileToImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
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

function scoreMatch(
  gray: Float32Array,
  imgW: number,
  imgH: number,
  tpl: PreparedTemplate,
  x: number,
  y: number
): number {
  const { width: tw, height: th, mask, norm, count } = tpl;
  if (x < 0 || y < 0 || x + tw > imgW || y + th > imgH) return -1;

  let sum = 0;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const ti = ty * tw + tx;
      if (!mask[ti]) continue;
      sum += gray[(y + ty) * imgW + (x + tx)];
    }
  }

  const mean = sum / count;
  let varP = 0;
  let ncc = 0;

  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const ti = ty * tw + tx;
      if (!mask[ti]) continue;
      const pv = gray[(y + ty) * imgW + (x + tx)] - mean;
      varP += pv * pv;
      ncc += norm[ti] * pv;
    }
  }

  const std = Math.sqrt(varP / count) || 0.001;
  return ncc / (count * std);
}

function searchTemplate(
  gray: Float32Array,
  imgW: number,
  imgH: number,
  tpl: PreparedTemplate,
  stride: number,
  roi?: { x1: number; y1: number; x2: number; y2: number }
): { score: number; x: number; y: number } {
  let bestScore = -1;
  let bestX = 0;
  let bestY = 0;

  const x1 = roi?.x1 ?? 0;
  const y1 = roi?.y1 ?? 0;
  const x2 = roi?.x2 ?? imgW - tpl.width;
  const y2 = roi?.y2 ?? imgH - tpl.height;

  for (let y = y1; y <= y2; y += stride) {
    for (let x = x1; x <= x2; x += stride) {
      const score = scoreMatch(gray, imgW, imgH, tpl, x, y);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  return { score: bestScore, x: bestX, y: bestY };
}

function regionFromBox(
  x: number,
  y: number,
  w: number,
  h: number,
  imgW: number,
  imgH: number,
  padRatio = PAD_RATIO
): MaskRegion {
  const padX = Math.round(w * padRatio);
  const padY = Math.round(h * padRatio);
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

async function getTemplates() {
  if (!templatesCache) {
    templatesCache = await buildTemplates();
  }
  return templatesCache;
}

export async function detectGeminiLogo(
  imageSource: Blob | File
): Promise<GeminiDetectionResult | null> {
  const [img, templates] = await Promise.all([fileToImage(imageSource), getTemplates()]);

  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  const maxSearchEdge = 1400;
  const searchScale = Math.min(1, maxSearchEdge / Math.max(naturalW, naturalH));
  const searchW = Math.max(1, Math.round(naturalW * searchScale));
  const searchH = Math.max(1, Math.round(naturalH * searchScale));

  const searchData = imageToImageData(img, searchW, searchH);
  const gray = toGrayscale(searchData);

  let globalBest = {
    score: -1,
    x: 0,
    y: 0,
    tpl: templates[0],
  };

  for (const tpl of templates) {
    if (tpl.width >= searchW || tpl.height >= searchH) continue;

    const searchRoi = getGeminiSearchRoi(searchW, searchH, tpl.width, tpl.height);
    if (searchRoi.x2 < searchRoi.x1 || searchRoi.y2 < searchRoi.y1) continue;

    const coarse = searchTemplate(gray, searchW, searchH, tpl, 6, searchRoi);
    if (coarse.score <= globalBest.score) continue;

    const fineRadius = 8;
    const roi = {
      x1: Math.max(searchRoi.x1, coarse.x - fineRadius),
      y1: Math.max(searchRoi.y1, coarse.y - fineRadius),
      x2: Math.min(searchRoi.x2, coarse.x + fineRadius),
      y2: Math.min(searchRoi.y2, coarse.y + fineRadius),
    };

    const fine = searchTemplate(gray, searchW, searchH, tpl, 1, roi);
    if (fine.score > globalBest.score) {
      globalBest = { ...fine, tpl };
    }
  }

  if (globalBest.score < MIN_SCORE) {
    return null;
  }

  let finalX = Math.round(globalBest.x / searchScale);
  let finalY = Math.round(globalBest.y / searchScale);
  let finalTpl = globalBest.tpl;
  let finalScore = globalBest.score;

  if (searchScale < 0.99) {
    const fullData = imageToImageData(img, naturalW, naturalH);
    const fullGray = toGrayscale(fullData);
    const fullTplSize = Math.max(16, Math.round(globalBest.tpl.width / searchScale));
    const baseUrl =
      globalBest.tpl.baseSize === 48 ? TEMPLATE_URLS[0] : TEMPLATE_URLS[1];
    const baseImg = await loadImage(baseUrl);
    const fullTpl = prepareTemplateFromImageData(
      imageToImageData(baseImg, fullTplSize, fullTplSize),
      globalBest.tpl.baseSize,
      globalBest.tpl.scale
    );

    if (fullTpl.count > 0 && fullTpl.width < naturalW && fullTpl.height < naturalH) {
      const margin = Math.max(20, Math.round(fullTplSize * 0.75));
      const zoneRoi = getGeminiSearchRoi(naturalW, naturalH, fullTpl.width, fullTpl.height);
      const roi = {
        x1: Math.max(zoneRoi.x1, finalX - margin),
        y1: Math.max(zoneRoi.y1, finalY - margin),
        x2: Math.min(zoneRoi.x2, finalX + margin),
        y2: Math.min(zoneRoi.y2, finalY + margin),
      };

      if (roi.x2 >= roi.x1 && roi.y2 >= roi.y1) {
        const refined = searchTemplate(fullGray, naturalW, naturalH, fullTpl, 1, roi);
        if (refined.score >= finalScore * 0.85) {
          finalX = refined.x;
          finalY = refined.y;
          finalTpl = fullTpl;
          finalScore = refined.score;
        }
      }
    }
  }

  return {
    region: regionFromBox(finalX, finalY, finalTpl.width, finalTpl.height, naturalW, naturalH),
    confidence: finalScore,
    scale: finalTpl.scale,
    templateSize: finalTpl.baseSize,
  };
}

export function clearGeminiTemplateCache() {
  templatesCache = null;
}
