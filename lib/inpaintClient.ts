const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.88;
const MAX_TOTAL_BYTES = 3_500_000;

function loadImageSource(file: Blob): Promise<CanvasImageSource> {
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode image"))),
      type,
      quality
    );
  });
}

export async function prepareInpaintFiles(
  imageFile: File | Blob,
  maskBlob: Blob,
  maxEdge = MAX_EDGE
): Promise<{ image: Blob; mask: Blob; width: number; height: number }> {
  const [imageSource, maskSource] = await Promise.all([
    loadImageSource(imageFile),
    loadImageSource(maskBlob),
  ]);

  const naturalW =
    imageSource instanceof HTMLImageElement
      ? imageSource.naturalWidth
      : (imageSource as ImageBitmap).width;
  const naturalH =
    imageSource instanceof HTMLImageElement
      ? imageSource.naturalHeight
      : (imageSource as ImageBitmap).height;

  const scale = Math.min(1, maxEdge / Math.max(naturalW, naturalH));
  const width = Math.max(1, Math.round(naturalW * scale));
  const height = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  ctx.drawImage(imageSource, 0, 0, width, height);
  const image = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(maskSource, 0, 0, width, height);
  const mask = await canvasToBlob(canvas, "image/png");

  if (image.size + mask.size > MAX_TOTAL_BYTES && maxEdge > 960) {
    return prepareInpaintFiles(imageFile, maskBlob, Math.floor(maxEdge * 0.75));
  }

  return { image, mask, width, height };
}

export async function prepareInpaintBase64(imageFile: File | Blob, maskBlob: Blob) {
  const { image, mask, width, height } = await prepareInpaintFiles(imageFile, maskBlob);
  const [imageBase64, maskBase64] = await Promise.all([
    blobToBase64(image),
    blobToBase64(mask),
  ]);
  return { imageBase64, maskBase64, width, height };
}

export const INPAINT_API_URL =
  process.env.NEXT_PUBLIC_INPAINT_API_URL ||
  "https://sanster-iopaint-lama.hf.space/api/v1/inpaint";

export async function inpaintFromBrowser(
  imageFile: File | Blob,
  maskBlob: Blob,
  featherPx = 12
): Promise<Blob> {
  const { imageBase64, maskBase64 } = await prepareInpaintBase64(imageFile, maskBlob);

  const payload = {
    image: imageBase64,
    mask: maskBase64,
    model: "lama",
    hd_strategy: "Crop",
    hd_strategy_crop_triger_size: 640,
    hd_strategy_crop_margin: 128,
    sd_mask_blur: Math.max(0, featherPx),
  };

  const response = await fetch(INPAINT_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Inpaint API error (${response.status}): ${text.slice(0, 200)}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const data = await response.json();
    if (data.image) {
      const binary = atob(data.image);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: "image/png" });
    }
    throw new Error(data.detail || data.error || "API returned no image");
  }

  return response.blob();
}

export async function inpaintViaApiRoute(
  imageFile: File | Blob,
  maskBlob: Blob,
  featherPx: number
): Promise<Blob> {
  const { image, mask } = await prepareInpaintFiles(imageFile, maskBlob);

  const formData = new FormData();
  formData.append("image", image, "image.jpg");
  formData.append("mask", mask, "mask.png");
  formData.append("featherPx", String(featherPx));

  const response = await fetch("/api/inpaint", {
    method: "POST",
    body: formData,
  });

  if (response.status === 413) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return response.blob();
}

/** Prefer browser → HF API (avoids Vercel 4.5MB body limit). Falls back to /api/inpaint locally. */
export async function removeLogo(
  imageFile: File,
  maskBlob: Blob,
  featherPx: number
): Promise<Blob> {
  try {
    return await inpaintFromBrowser(imageFile, maskBlob, featherPx);
  } catch (browserError) {
    console.warn("Direct inpaint failed, trying API route:", browserError);
    return inpaintViaApiRoute(imageFile, maskBlob, featherPx);
  }
}
