import sharp from "sharp";

export const INPAINT_API_URL =
  process.env.INPAINT_API_URL ||
  "https://sanster-iopaint-lama.hf.space/api/v1/inpaint";

const API_TIMEOUT = 180_000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const RESIZE_MAX = 2048;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeBase64(buffer: Buffer) {
  return buffer.toString("base64");
}

export async function resizeIfNeeded(buffer: Buffer) {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const { width = 0, height = 0 } = metadata;

  if (Math.max(width, height) <= RESIZE_MAX) {
    return {
      buffer,
      width,
      height,
      originalWidth: width,
      originalHeight: height,
    };
  }

  const resizedBuffer = await image
    .resize({
      width: width > height ? RESIZE_MAX : undefined,
      height: height >= width ? RESIZE_MAX : undefined,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 95 })
    .toBuffer();

  const resizedMeta = await sharp(resizedBuffer).metadata();
  return {
    buffer: resizedBuffer,
    width: resizedMeta.width ?? width,
    height: resizedMeta.height ?? height,
    originalWidth: width,
    originalHeight: height,
  };
}

async function callInpaintApi(imageBase64: string, maskBase64: string) {
  const payload = {
    image: imageBase64,
    mask: maskBase64,
    model: "lama",
    hd_strategy: "Crop",
    hd_strategy_crop_triger_size: 640,
    hd_strategy_crop_margin: 128,
    sd_mask_blur: 35,
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);

      const response = await fetch(INPAINT_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 200) {
        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
          const data = await response.json();
          if (data.image) {
            return Buffer.from(data.image, "base64");
          }
          throw new Error(data.detail || data.error || "API returned JSON without image");
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength === 0) {
          throw new Error("API returned empty response");
        }
        return Buffer.from(arrayBuffer);
      }

      if (response.status === 429) {
        await sleep(RETRY_DELAY * attempt);
        continue;
      }

      const errorText = await response.text();
      throw new Error(`API ${response.status}: ${errorText.slice(0, 200)}`);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await sleep(RETRY_DELAY);
    }
  }

  throw new Error("Inpaint failed after retries");
}

export async function processInpaint(
  imageBuffer: Buffer,
  maskBuffer: Buffer,
  featherPx: number
) {
  const { buffer, width, height } = await resizeIfNeeded(imageBuffer);

  let processedMask = await sharp(maskBuffer)
    .resize(width, height, { fit: "fill" })
    .grayscale()
    .png()
    .toBuffer();

  if (featherPx > 0) {
    processedMask = await sharp(processedMask)
      .blur(Math.max(0.3, featherPx / 2))
      .png()
      .toBuffer();
  }

  return callInpaintApi(encodeBase64(buffer), encodeBase64(processedMask));
}
