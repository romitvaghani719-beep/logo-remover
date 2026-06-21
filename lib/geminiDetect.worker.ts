/// <reference lib="webworker" />

import { detectGeminiLogo } from "./geminiDetect";
import type { GeminiDetectionResult } from "./geminiDetect";

export type GeminiWorkerRequest = {
  id: number;
  buffer: ArrayBuffer;
  type: string;
  name: string;
};

export type GeminiWorkerResponse =
  | { id: number; ok: true; result: GeminiDetectionResult | null }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<GeminiWorkerRequest>) => {
  const { id, buffer, type, name } = event.data;

  try {
    const file = new File([buffer], name, { type });
    const result = await detectGeminiLogo(file);
    const response: GeminiWorkerResponse = { id, ok: true, result };
    ctx.postMessage(response);
  } catch (err) {
    const response: GeminiWorkerResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : "Detection failed",
    };
    ctx.postMessage(response);
  }
};
