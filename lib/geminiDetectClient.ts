import { detectGeminiLogo as detectGeminiLogoSync } from "@/lib/geminiDetect";
import type { GeminiDetectionResult } from "@/lib/geminiDetect";
import type { GeminiWorkerResponse } from "@/lib/geminiDetect.worker";

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<
  number,
  {
    resolve: (value: GeminiDetectionResult | null) => void;
    reject: (reason: Error) => void;
  }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./geminiDetect.worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<GeminiWorkerResponse>) => {
      const { id, ok } = event.data;
      const handler = pending.get(id);
      if (!handler) return;
      pending.delete(id);

      if (ok) {
        handler.resolve(event.data.result);
        return;
      }

      handler.reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      for (const [, handler] of pending) {
        handler.reject(new Error("Gemini detection worker failed"));
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function detectGeminiLogoInWorker(file: File): Promise<GeminiDetectionResult | null> {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });

    void file
      .arrayBuffer()
      .then((buffer) => {
        getWorker().postMessage(
          { id, buffer, type: file.type, name: file.name },
          [buffer]
        );
      })
      .catch((err) => {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error("Failed to read image"));
      });
  });
}

export async function detectGeminiLogo(
  file: File
): Promise<GeminiDetectionResult | null> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return detectGeminiLogoSync(file);
  }

  try {
    return await detectGeminiLogoInWorker(file);
  } catch {
    return detectGeminiLogoSync(file);
  }
}

export { clearGeminiTemplateCache } from "@/lib/geminiDetect";
