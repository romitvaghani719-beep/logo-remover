import type { MaskRegion } from "@/types";

const ALPHA_THRESHOLD = 0.002;
const MAX_ALPHA = 0.99;
const LOGO_VALUE = 255;

const ALPHA_MAP_URLS: Record<48 | 96, string> = {
  48: "/alpha/bg_48.png",
  96: "/alpha/bg_96.png",
};

const alphaCache = new Map<string, Float32Array>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load alpha asset: ${url}`));
    img.src = url;
  });
}

export function calculateAlphaMap(imageData: ImageData): Float32Array {
  const { width, height, data } = imageData;
  const alphaMap = new Float32Array(width * height);
  for (let i = 0; i < alphaMap.length; i++) {
    const idx = i * 4;
    const maxChannel = Math.max(data[idx], data[idx + 1], data[idx + 2]);
    alphaMap[i] = maxChannel / 255;
  }
  return alphaMap;
}

async function loadAlphaMapFromUrl(url: string, size: number): Promise<Float32Array> {
  const cacheKey = `${url}@${size}`;
  const cached = alphaCache.get(cacheKey);
  if (cached) return cached;

  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0, size, size);
  const alphaMap = calculateAlphaMap(ctx.getImageData(0, 0, size, size));
  alphaCache.set(cacheKey, alphaMap);
  return alphaMap;
}

/** Load canonical alpha map, optionally resized to target logo pixel size. */
export async function getAlphaMapForLogoSize(
  sourceSize: 48 | 96,
  targetSize: number
): Promise<Float32Array> {
  const url = ALPHA_MAP_URLS[sourceSize];
  if (targetSize === sourceSize) {
    return loadAlphaMapFromUrl(url, sourceSize);
  }

  const cacheKey = `${url}@scaled${targetSize}`;
  const cached = alphaCache.get(cacheKey);
  if (cached) return cached;

  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0, targetSize, targetSize);
  const alphaMap = calculateAlphaMap(ctx.getImageData(0, 0, targetSize, targetSize));
  alphaCache.set(cacheKey, alphaMap);
  return alphaMap;
}

export function removeWatermarkAlphaBlend(
  imageData: ImageData,
  alphaMap: Float32Array,
  alphaW: number,
  alphaH: number,
  x: number,
  y: number
): void {
  const { width: imgW, data } = imageData;

  for (let row = 0; row < alphaH; row++) {
    for (let col = 0; col < alphaW; col++) {
      const px = x + col;
      const py = y + row;
      if (px < 0 || py < 0 || px >= imageData.width || py >= imageData.height) continue;

      const imgIdx = (py * imgW + px) * 4;
      const alphaIdx = row * alphaW + col;
      let alpha = alphaMap[alphaIdx];
      if (alpha < ALPHA_THRESHOLD) continue;

      alpha = Math.min(alpha, MAX_ALPHA);
      const oneMinusAlpha = 1 - alpha;

      for (let c = 0; c < 3; c++) {
        const watermarked = data[imgIdx + c];
        const original = (watermarked - alpha * LOGO_VALUE) / oneMinusAlpha;
        data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
      }
    }
  }
}

export async function loadImageSource(file: Blob): Promise<HTMLImageElement> {
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

export async function applyAlphaRemoval(
  imageFile: Blob,
  logoRect: MaskRegion,
  alphaSourceSize: 48 | 96,
  logoSize: number
): Promise<Blob> {
  const img = await loadImageSource(imageFile);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const alphaMap = await getAlphaMapForLogoSize(alphaSourceSize, logoSize);

  removeWatermarkAlphaBlend(
    imageData,
    alphaMap,
    logoSize,
    logoSize,
    Math.round(logoRect.x1),
    Math.round(logoRect.y1)
  );

  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode result"))),
      "image/png"
    );
  });
}

export async function regionToMaskBlob(
  imgW: number,
  imgH: number,
  region: MaskRegion
): Promise<Blob> {
  return regionsToCombinedMaskBlob(imgW, imgH, [region]);
}

/** Union mask covering multiple regions (e.g. V1 + V2 fallback slots). */
export async function regionsToCombinedMaskBlob(
  imgW: number,
  imgH: number,
  regions: MaskRegion[]
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = imgW;
  canvas.height = imgH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, imgW, imgH);
  ctx.fillStyle = "#fff";
  for (const region of regions) {
    ctx.fillRect(region.x1, region.y1, region.width, region.height);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to create mask"))),
      "image/png"
    );
  });
}
