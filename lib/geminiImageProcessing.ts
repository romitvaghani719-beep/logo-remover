import { CORNER_SEARCH_FALLBACK_FRACTION } from "@/lib/geminiSearchZone";

export interface RgbPlanes {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

/** All fields used for debug steps 3–5 and template matching. */
export interface LogoProcessingStack {
  /** Step 3 — pixels lifted above local RGB background (logo glows bright). */
  lift: Float32Array;
  /** Step 4 — per-channel white top-hat (faint watermark residual). */
  watermark: Float32Array;
  /** Step 5 — wide contrast on lift field (star shape). */
  shapeContrast: Float32Array;
  gray: Float32Array;
  edges: Float32Array;
}

export function extractRgbPlanes(data: ImageData): RgbPlanes {
  const n = data.width * data.height;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    r[i] = data.data[o];
    g[i] = data.data[o + 1];
    b[i] = data.data[o + 2];
  }
  return { r, g, b };
}

export function boxBlur(
  src: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array {
  const temp = new Float32Array(src.length);
  const out = new Float32Array(src.length);

  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const add = x + radius;
      const sub = x - radius - 1;
      if (x === 0) {
        const end = Math.min(width, radius * 2 + 1);
        for (let k = 0; k < end; k++) sum += src[y * width + k];
      } else {
        if (add < width) sum += src[y * width + add];
        if (sub >= 0) sum -= src[y * width + sub];
      }
      const count = Math.min(width, x + radius + 1) - Math.max(0, x - radius);
      temp[y * width + x] = sum / count;
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      const add = y + radius;
      const sub = y - radius - 1;
      if (y === 0) {
        const end = Math.min(height, radius * 2 + 1);
        for (let k = 0; k < end; k++) sum += temp[k * width + x];
      } else {
        if (add < height) sum += temp[add * width + x];
        if (sub >= 0) sum -= temp[sub * width + x];
      }
      const count = Math.min(height, y + radius + 1) - Math.max(0, y - radius);
      out[y * width + x] = sum / count;
    }
  }

  return out;
}

function channelTopHat(
  channel: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array {
  const bg = boxBlur(channel, width, height, radius);
  const out = new Float32Array(channel.length);
  for (let i = 0; i < channel.length; i++) {
    out[i] = Math.max(0, channel[i] - bg[i]);
  }
  return out;
}

function mergeMax(target: Float32Array, source: Float32Array): void {
  for (let i = 0; i < target.length; i++) {
    if (source[i] > target[i]) target[i] = source[i];
  }
}

/** Per-channel RGB top-hat at several scales — white logo rises above matching background. */
function buildRgbWatermark(planes: RgbPlanes, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (const radius of [3, 5, 8, 12, 18]) {
    mergeMax(out, channelTopHat(planes.r, width, height, radius));
    mergeMax(out, channelTopHat(planes.g, width, height, radius));
    mergeMax(out, channelTopHat(planes.b, width, height, radius));
  }

  const dogR0 = boxBlur(planes.r, width, height, 2);
  const dogR1 = boxBlur(planes.r, width, height, 7);
  const dogG0 = boxBlur(planes.g, width, height, 2);
  const dogG1 = boxBlur(planes.g, width, height, 7);
  const dogB0 = boxBlur(planes.b, width, height, 2);
  const dogB1 = boxBlur(planes.b, width, height, 7);
  for (let i = 0; i < out.length; i++) {
    const dog = Math.max(
      0,
      dogR0[i] - dogR1[i],
      dogG0[i] - dogG1[i],
      dogB0[i] - dogB1[i]
    );
    if (dog > out[i]) out[i] = dog;
  }

  return out;
}

/** min(R,G,B) — strongest for neutral white / gray watermarks. */
function buildWhiteness(planes: RgbPlanes): Float32Array {
  const out = new Float32Array(planes.r.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(planes.r[i], planes.g[i], planes.b[i]);
  }
  return out;
}

function estimateCornerFloor(gray: Float32Array, width: number, height: number): number {
  const fraction = CORNER_SEARCH_FALLBACK_FRACTION;
  const x1 = Math.round(width * (1 - fraction));
  const y1 = Math.round(height * (1 - fraction));
  const exclude = Math.max(32, Math.round(Math.min(width, height) * 0.06));
  const samples: number[] = [];

  for (let x = x1; x < width - exclude; x++) samples.push(gray[(height - 1) * width + x]);
  for (let y = y1; y < height - exclude; y++) samples.push(gray[y * width + (width - 1)]);

  if (samples.length === 0) return 128;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * 0.5)];
}

/** Logo lift: how much each pixel is brighter than local RGB background. */
function buildLogoLift(planes: RgbPlanes, width: number, height: number): Float32Array {
  const whiteness = buildWhiteness(planes);
  const watermark = buildRgbWatermark(planes, width, height);
  const lift = new Float32Array(width * height);

  for (const radius of [4, 7, 11, 16]) {
    mergeMax(lift, channelTopHat(whiteness, width, height, radius));
  }
  mergeMax(lift, watermark);

  const floor = estimateCornerFloor(whiteness, width, height);
  const x1 = Math.round(width * (1 - CORNER_SEARCH_FALLBACK_FRACTION));
  const y1 = Math.round(height * (1 - CORNER_SEARCH_FALLBACK_FRACTION));
  for (let y = y1; y < height; y++) {
    for (let x = x1; x < width; x++) {
      const i = y * width + x;
      const cornerLift = Math.max(0, whiteness[i] - floor);
      if (cornerLift > lift[i]) lift[i] = cornerLift;
    }
  }

  return lift;
}

function toLocalContrast(
  field: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          sum += field[ny * width + nx];
          n++;
        }
      }
      out[y * width + x] = field[y * width + x] - sum / n;
    }
  }
  return out;
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

export function buildLogoProcessingStack(data: ImageData): LogoProcessingStack {
  const { width, height } = data;
  const planes = extractRgbPlanes(data);
  const lift = buildLogoLift(planes, width, height);
  const watermark = buildRgbWatermark(planes, width, height);
  const shapeContrast = toLocalContrast(lift, width, height, 7);

  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * planes.r[i] + 0.587 * planes.g[i] + 0.114 * planes.b[i];
  }

  const edges = sobelMagnitudes(
    Float32Array.from(gray, (v) => v / 255),
    width,
    height
  );

  return { lift, watermark, shapeContrast, gray, edges };
}

/** Step 3 debug: RGB image — dark background, logo lifted bright white. */
export function liftFieldToRgbImage(
  lift: Float32Array,
  width: number,
  height: number
): ImageData {
  const finite = [...lift].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const pLow = finite[Math.floor(finite.length * 0.02)] ?? 0;
  const pHigh = finite[Math.floor(finite.length * 0.99)] ?? 1;
  const span = pHigh - pLow || 1;

  const out = new ImageData(width, height);
  for (let i = 0; i < lift.length; i++) {
    const o = i * 4;
    const v = lift[i];
    const t = Math.max(0, Math.min(1, (Math.min(pHigh, Math.max(pLow, v)) - pLow) / span));
    const boosted = Math.pow(t, 0.65);
    const bg = 18;
    const lum = Math.round(bg + boosted * (255 - bg));
    out.data[o] = lum;
    out.data[o + 1] = Math.round(lum * 0.98);
    out.data[o + 2] = Math.round(lum * 0.92);
    out.data[o + 3] = 255;
  }
  return out;
}
