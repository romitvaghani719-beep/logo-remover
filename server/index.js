import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, "../client/dist");

const app = express();
const PORT = process.env.PORT || 3001;

const API_URL =
  process.env.INPAINT_API_URL ||
  "https://sanster-iopaint-lama.hf.space/api/v1/inpaint";

const API_TIMEOUT = 180_000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const RESIZE_MAX = 2048;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const uploadPair = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
}).fields([
  { name: "image", maxCount: 1 },
  { name: "mask", maxCount: 1 },
]);

app.use(cors());
app.use(express.json({ limit: "30mb" }));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeBase64(buffer) {
  return buffer.toString("base64");
}

async function resizeIfNeeded(buffer) {
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
      resized: false,
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
    resized: true,
  };
}

function scaleClickToProcessed(clickX, clickY, originalWidth, originalHeight, width, height) {
  if (!originalWidth || !originalHeight) {
    return { clickX, clickY };
  }

  return {
    clickX: clickX * (width / originalWidth),
    clickY: clickY * (height / originalHeight),
  };
}

async function createMaskBuffer(
  width,
  height,
  {
    clickX,
    clickY,
    maskWidthRatio = 0.18,
    maskHeightRatio = 0.12,
    featherPx = 14,
    anchor = "center",
  }
) {
  const boxW = Math.max(8, Math.round(width * maskWidthRatio));
  const boxH = Math.max(8, Math.round(height * maskHeightRatio));

  let x1;
  let y1;

  if (anchor === "bottom-right") {
    const padX = Math.round(width * 0.02);
    const padY = Math.round(height * 0.02);
    const x2 = width - padX;
    const y2 = height - padY;
    x1 = Math.max(0, x2 - boxW);
    y1 = Math.max(0, y2 - boxH);
  } else {
    x1 = Math.round(clickX - boxW / 2);
    y1 = Math.round(clickY - boxH / 2);
    x1 = Math.max(0, Math.min(x1, width - boxW));
    y1 = Math.max(0, Math.min(y1, height - boxH));
  }

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${x1}" y="${y1}" width="${boxW}" height="${boxH}" fill="white"/>
    </svg>
  `;

  let mask = sharp(Buffer.from(svg)).png();

  if (featherPx > 0) {
    mask = mask.blur(Math.max(0.3, featherPx / 2));
  }

  const maskBuffer = await mask.toBuffer();

  return {
    maskBuffer,
    region: { x1, y1, x2: x1 + boxW, y2: y1 + boxH, width: boxW, height: boxH },
  };
}

async function callInpaintApi(imageBase64, maskBase64) {
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

      const response = await fetch(API_URL, {
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
        const wait = RETRY_DELAY * attempt;
        console.warn(`Rate limited, retrying in ${wait}ms...`);
        await sleep(wait);
        continue;
      }

      const errorText = await response.text();
      throw new Error(`API ${response.status}: ${errorText.slice(0, 200)}`);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      console.warn(`Attempt ${attempt} failed:`, error.message);
      await sleep(RETRY_DELAY);
    }
  }

  throw new Error("Inpaint failed after retries");
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, api: API_URL });
});

app.post("/api/mask-preview", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" });
    }

    const clickX = Number(req.body.clickX);
    const clickY = Number(req.body.clickY);
    const maskWidthRatio = Number(req.body.maskWidthRatio ?? 0.18);
    const maskHeightRatio = Number(req.body.maskHeightRatio ?? 0.12);
    const featherPx = Number(req.body.featherPx ?? 14);
    const anchor = req.body.anchor ?? "center";

    if (Number.isNaN(clickX) || Number.isNaN(clickY)) {
      return res.status(400).json({ error: "clickX and clickY are required" });
    }

    const {
      buffer,
      width,
      height,
      originalWidth,
      originalHeight,
    } = await resizeIfNeeded(req.file.buffer);

    const scaled = scaleClickToProcessed(
      clickX,
      clickY,
      originalWidth,
      originalHeight,
      width,
      height
    );

    const { maskBuffer, region } = await createMaskBuffer(width, height, {
      clickX: scaled.clickX,
      clickY: scaled.clickY,
      maskWidthRatio,
      maskHeightRatio,
      featherPx,
      anchor,
    });

    res.json({
      maskPreview: `data:image/png;base64,${encodeBase64(maskBuffer)}`,
      imageWidth: width,
      imageHeight: height,
      originalWidth,
      originalHeight,
      region,
      resized: width !== originalWidth || height !== originalHeight,
    });
  } catch (error) {
    console.error("Mask preview error:", error);
    res.status(500).json({ error: error.message || "Failed to create mask preview" });
  }
});

app.post("/api/inpaint", uploadPair, async (req, res) => {
  try {
    const imageFile = req.files?.image?.[0];
    const maskFile = req.files?.mask?.[0];

    if (!imageFile) {
      return res.status(400).json({ error: "Image file is required" });
    }

    if (!maskFile) {
      return res.status(400).json({ error: "Mask is required — mark the logo on the image first" });
    }

    const featherPx = Number(req.body.featherPx ?? 12);

    const { buffer, width, height } = await resizeIfNeeded(imageFile.buffer);

    let maskBuffer = await sharp(maskFile.buffer)
      .resize(width, height, { fit: "fill" })
      .grayscale()
      .png()
      .toBuffer();

    if (featherPx > 0) {
      maskBuffer = await sharp(maskBuffer)
        .blur(Math.max(0.3, featherPx / 2))
        .png()
        .toBuffer();
    }

    const imageBase64 = encodeBase64(buffer);
    const maskBase64 = encodeBase64(maskBuffer);

    const resultBuffer = await callInpaintApi(imageBase64, maskBase64);

    res.set("Content-Type", "image/png");
    res.send(resultBuffer);
  } catch (error) {
    console.error("Inpaint error:", error);
    res.status(500).json({ error: error.message || "Inpaint failed" });
  }
});

app.use(express.static(clientDist));

app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) res.status(404).json({ error: "Not found" });
  });
});

app.listen(PORT, () => {
  console.log(`Logo remover server running on http://localhost:${PORT}`);
  console.log(`Inpaint API: ${API_URL}`);
});
