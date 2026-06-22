"use client";

import { useCallback, useRef, useState } from "react";
import { DetectionFlowViewer } from "@/components/DetectionFlowViewer";
import { detectGeminiLogoWithDebug } from "@/lib/geminiDetectClient";
import type { DetectionDebugMeta, DetectionDebugStep } from "@/lib/geminiDetectDebug";

export default function DebugDetectPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [steps, setSteps] = useState<DetectionDebugStep[]>([]);
  const [meta, setMeta] = useState<DetectionDebugMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const runDebug = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setSteps([]);
    setMeta(null);
    setFileName(file.name);

    try {
      const output = await detectGeminiLogoWithDebug(file);
      setSteps(output.steps);
      setMeta(output.meta);
      if (!output.result) {
        setError("No confident Gemini logo match — flow images still show what was tried.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Debug detection failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const onFile = (file: File | undefined) => {
    if (file) void runDebug(file);
  };

  const openFilePicker = () => fileInputRef.current?.click();

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-950/40 via-surface-950 to-surface-950 text-white">
      <header className="border-b border-white/5 bg-surface-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">Gemini detect — debug flow</h1>
            <p className="text-sm text-gray-400">
              Upload an image to see every processing step as output images.
            </p>
          </div>
          <a href="/" className="text-sm text-accent hover:underline">
            ← Back to app
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8">
        <section
          className="mx-auto flex max-w-2xl cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-accent/50 bg-accent/10 p-10 text-center shadow-glow transition hover:border-accent hover:bg-accent/15"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFile(e.dataTransfer.files[0]);
          }}
          onClick={openFilePicker}
        >
          <div className="mb-4 rounded-2xl bg-accent/25 p-4 text-accent">
            <svg
              className="h-12 w-12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>

          <h2 className="text-lg font-semibold text-white">Drop an image or click to upload</h2>
          <p className="mt-2 max-w-md text-sm text-gray-300">
            Generates a numbered image sequence: original → grayscale → edges → zones →
            match → final mask.
          </p>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openFilePicker();
            }}
            disabled={loading}
            className="mt-6 rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white shadow-glow transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Processing..." : "Choose image"}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </section>

        {loading && (
          <div className="flex items-center justify-center gap-2 text-sm text-accent">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            Building debug image sequence{fileName ? ` for ${fileName}` : ""}...
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            {error}
          </div>
        )}

        {meta && steps.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-gray-400">
                Showing flow for <span className="font-mono text-white">{fileName}</span>
              </p>
              <button
                type="button"
                onClick={openFilePicker}
                disabled={loading}
                className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-sm text-accent hover:bg-accent/20 disabled:opacity-50"
              >
                Upload another image
              </button>
            </div>
            <DetectionFlowViewer steps={steps} meta={meta} />
          </>
        )}
      </main>
    </div>
  );
}
