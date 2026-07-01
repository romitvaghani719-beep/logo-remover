"use client";

import { useCallback, useEffect, useState } from "react";
import { MaskCanvas, ToolControls } from "@/components/ImageEditor";
import { detectGeminiLogo } from "@/lib/geminiDetectClient";
import type { GeminiDetectionResult } from "@/lib/geminiDetect";
import {
  ALPHA_CONFIDENCE_THRESHOLD,
  RESIDUAL_DETECTION_THRESHOLD,
  runHybridRemoval,
  getPlannedRemovalMode,
  type RemovalPassLog,
} from "@/lib/hybridRemoval";
import {
  getWatermarkFallbackProfiles,
  type WatermarkProfile,
} from "@/lib/watermarkProfiles";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  type MaskRegion,
} from "@/types";

type Step = "upload" | "edit" | "result";

export default function LogoRemoverApp() {
  const [step, setStep] = useState<Step>("upload");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [maskBlob, setMaskBlob] = useState<Blob | null>(null);
  const [region, setRegion] = useState<MaskRegion | null>(null);
  const [settings, setSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectConfidence, setDetectConfidence] = useState<number | null>(null);
  const [detectionResult, setDetectionResult] = useState<GeminiDetectionResult | null>(null);
  const [detectedRegion, setDetectedRegion] = useState<MaskRegion | null>(null);
  const [fallbackProfiles, setFallbackProfiles] = useState<WatermarkProfile[]>([]);
  const [selectedFallback, setSelectedFallback] = useState<WatermarkProfile | null>(null);
  const [passLog, setPassLog] = useState<RemovalPassLog[]>([]);
  const [residualClean, setResidualClean] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  const plannedMode = getPlannedRemovalMode(detectConfidence);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setApiOk(Boolean(d.ok)))
      .catch(() => setApiOk(false));
  }, []);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [imageUrl, resultUrl]);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Please upload a valid image file.");
      return;
    }

    setError(null);
    setMaskBlob(null);
    setRegion(null);
    setDetectedRegion(null);
    setDetectionResult(null);
    setDetectConfidence(null);
    setSelectedFallback(null);
    setPassLog([]);
    setResidualClean(null);
    setFallbackProfiles([]);
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    setImageFile(file);
    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setStep("edit");
  }, []);

  const runAutoDetect = useCallback(async (file: File) => {
    setDetecting(true);
    setError(null);
    setDetectedRegion(null);
    setDetectionResult(null);
    setDetectConfidence(null);
    setSelectedFallback(null);

    try {
      const bitmap = await createImageBitmap(file);
      const profiles = getWatermarkFallbackProfiles(bitmap.width, bitmap.height);
      bitmap.close();
      setFallbackProfiles(profiles);

      const result = await detectGeminiLogo(file);
      if (!result) {
        setError(
          "Gemini logo not detected. Click Remove logo to brush both V1 + V2 fallback zones, then alpha if needed."
        );
        return;
      }

      setDetectedRegion(result.region);
      setDetectionResult(result);
      setDetectConfidence(result.confidence);

      if (result.confidence >= ALPHA_CONFIDENCE_THRESHOLD) {
        setSettings((s) => ({ ...s, tool: "marquee" }));
      } else if (result.confidence >= RESIDUAL_DETECTION_THRESHOLD) {
        setError(
          `Detected at ${(result.confidence * 100).toFixed(0)}% — will use LaMa inpaint. Pick a fallback or adjust mask if needed.`
        );
      } else {
        setError("Low confidence — use fallback positions or manual selection.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto-detection failed");
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    if (step !== "edit" || !imageFile) return;
    void runAutoDetect(imageFile);
  }, [step, imageFile, runAutoDetect]);

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleMaskChange = useCallback((blob: Blob | null, nextRegion: MaskRegion | null) => {
    setMaskBlob(blob);
    setRegion(nextRegion);
    if (blob) setSelectedFallback(null);
  }, []);

  const selectFallback = (profile: WatermarkProfile) => {
    setSelectedFallback(profile);
    setDetectedRegion(profile.region);
    setDetectionResult(null);
    setDetectConfidence(null);
    setError(null);
    setSettings((s) => ({ ...s, tool: "marquee" }));
  };

  const canRemove = Boolean(imageFile);

  const removeLogo = async () => {
    if (!imageFile) {
      setError("Upload an image first.");
      return;
    }

    setLoading(true);
    setError(null);
    setPassLog([]);
    setResidualClean(null);

    try {
      const result = await runHybridRemoval({
        imageFile,
        featherPx: settings.featherPx,
        maskBlob,
        manualRegion: region,
        initialDetection: selectedFallback ? null : detectionResult,
        selectedFallback,
        fallbackProfiles,
        onPass: (log) => setPassLog((prev) => [...prev, log]),
      });

      const url = URL.createObjectURL(result.blob);
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setPassLog(result.passes);
      setResidualClean(result.clean);

      if (!result.clean && result.finalDetection) {
        setError(
          `Logo may still be visible (${(result.finalDetection.confidence * 100).toFixed(0)}% after ${result.passes.length} pass(es)). Edit again or use brush.`
        );
      }

      setStep("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove logo");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep("upload");
    setImageFile(null);
    setMaskBlob(null);
    setRegion(null);
    setDetectedRegion(null);
    setDetectionResult(null);
    setDetectConfidence(null);
    setSelectedFallback(null);
    setFallbackProfiles([]);
    setPassLog([]);
    setResidualClean(null);
    setError(null);
    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  };

  const downloadResult = () => {
    if (!resultUrl || !imageFile) return;
    const link = document.createElement("a");
    link.href = resultUrl;
    link.download = `clean-${imageFile.name.replace(/\.[^.]+$/, "")}.png`;
    link.click();
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-950/40 via-surface-950 to-surface-950">
      <header className="border-b border-white/5 bg-surface-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              Gemini Logo Remover
            </h1>
            <p className="text-sm text-gray-400">
              Alpha blend when confident · LaMa inpaint + GWT fallbacks · auto re-check
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <a href="/debug" className="text-accent hover:underline">
              Detection flow
            </a>
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  apiOk === null
                    ? "bg-yellow-400"
                    : apiOk
                      ? "bg-emerald-400"
                      : "bg-red-400"
                }`}
              />
              <span className="text-gray-400">
                {apiOk === null
                  ? "Checking API..."
                  : apiOk
                    ? "Inpaint API ready"
                    : "Inpaint API offline"}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {step === "upload" && (
          <div
            className="glass mx-auto flex min-h-[420px] max-w-2xl cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/15 p-10 transition hover:border-accent/50 hover:bg-white/[0.03]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onClick={() => document.getElementById("file-input")?.click()}
          >
            <div className="mb-4 rounded-2xl bg-accent/20 p-4 text-accent">
              <svg
                className="h-10 w-10"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-white">
              Drop an image or click to upload
            </h2>
            <p className="mt-2 text-center text-sm text-gray-400">
              PNG, JPG, WEBP · ≥70% detection uses reverse alpha blending
            </p>
            <input
              id="file-input"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </div>
        )}

        {step === "edit" && imageUrl && imageFile && (
          <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-white">Remove watermark</h2>
                  <p className="text-sm text-gray-400">
                    {plannedMode === "alpha" &&
                      "High confidence — reverse alpha blend (no inpaint needed)."}
                    {plannedMode === "inpaint" &&
                      "Medium confidence — LaMa inpaint on detected area."}
                    {plannedMode === "dual-fallback" &&
                      "No match — Remove logo will brush V1 + V2 zones, then alpha if logo remains."}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => imageFile && void runAutoDetect(imageFile)}
                    disabled={loading || detecting}
                    className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {detecting ? "Detecting..." : "Re-detect"}
                  </button>
                  <button
                    onClick={reset}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5"
                  >
                    New image
                  </button>
                </div>
              </div>

              {detecting && (
                <div className="flex items-center gap-2 rounded-lg border border-accent/20 bg-accent/5 px-4 py-2 text-sm text-accent">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                  Scanning for Gemini logo...
                </div>
              )}

              {plannedMode === "dual-fallback" && fallbackProfiles.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
                  Both <strong>V1</strong> and <strong>V2</strong> fallback zones will be brushed
                  and inpainted. If a logo is still detected afterward, alpha blending runs
                  automatically.
                </div>
              )}

              {plannedMode === "alpha" && detectConfidence !== null && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
                  {(detectConfidence * 100).toFixed(0)}% confidence — will use{" "}
                  <strong>reverse alpha blending</strong> (GeminiWatermarkTool method).
                  Re-check runs automatically after removal.
                </div>
              )}

              <MaskCanvas
                imageUrl={imageUrl}
                settings={settings}
                onMaskChange={handleMaskChange}
                detectedRegion={detectedRegion}
                fallbackProfiles={fallbackProfiles}
                selectedFallbackId={selectedFallback?.id ?? null}
                highlightFallbacks={plannedMode !== "alpha"}
                dualFallbackPreview={plannedMode === "dual-fallback"}
                disabled={loading || detecting}
              />

              {error && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  {error}
                </div>
              )}

              <button
                onClick={removeLogo}
                disabled={loading || !canRemove}
                className={`flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  canRemove ? "bg-accent hover:bg-accent-hover shadow-glow" : "bg-accent/40"
                }`}
              >
                {loading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Removing watermark...
                  </>
                ) : plannedMode === "alpha" ? (
                  "Remove with alpha blend"
                ) : plannedMode === "dual-fallback" ? (
                  "Remove logo (V1 + V2 brush)"
                ) : (
                  "Remove logo"
                )}
              </button>
            </div>

            <aside className="space-y-4">
              <ToolControls
                settings={settings}
                onChange={setSettings}
                disabled={loading}
                plannedMode={plannedMode}
              />

              {fallbackProfiles.length > 0 && (
                <div className="glass space-y-2 rounded-xl p-4">
                  <p className="text-xs font-semibold text-gray-300">
                    GWT fallback positions
                  </p>
                  <p className="text-[11px] leading-relaxed text-gray-500">
                    Use when auto-detect fails or confidence is low. Applies LaMa inpaint
                    at the standard Gemini corner slot (logo may or may not be there).
                  </p>
                  <div className="space-y-2 pt-1">
                    {fallbackProfiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        disabled={loading || detecting}
                        onClick={() => selectFallback(profile)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition ${
                          selectedFallback?.id === profile.id
                            ? "border-amber-400/60 bg-amber-500/15 text-amber-100"
                            : "border-white/10 text-gray-300 hover:bg-white/5"
                        }`}
                      >
                        <span className="font-medium">{profile.label}</span>
                        <span className="mt-0.5 block font-mono text-[10px] text-gray-500">
                          margin {profile.marginRight}px ·{" "}
                          {Math.round(profile.region.width)}×
                          {Math.round(profile.region.height)}px
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="glass rounded-xl p-4 text-xs leading-relaxed text-gray-400">
                <p className="mb-2 font-semibold text-gray-300">Pipeline</p>
                <ol className="list-decimal space-y-1 pl-4">
                  <li>Auto-detect in corner zone</li>
                  <li>≥70% → reverse alpha blend</li>
                  <li>28–69% → inpaint on detected area</li>
                  <li>No match → brush V1 + V2, then alpha if logo remains</li>
                  <li>Re-scan after each pass (up to 4)</li>
                </ol>
              </div>

              {detectConfidence !== null && (
                <div className="glass rounded-xl p-4 text-xs text-gray-400">
                  <p className="font-semibold text-gray-300">Auto-detect</p>
                  <p className="mt-1">
                    Confidence{" "}
                    <span
                      className={`font-mono ${
                        detectConfidence >= ALPHA_CONFIDENCE_THRESHOLD
                          ? "text-emerald-400"
                          : detectConfidence >= RESIDUAL_DETECTION_THRESHOLD
                            ? "text-amber-400"
                            : "text-red-400"
                      }`}
                    >
                      {(detectConfidence * 100).toFixed(0)}%
                    </span>
                  </p>
                  <p className="mt-1">
                    Method:{" "}
                    <span className="text-white">
                      {plannedMode === "alpha"
                        ? "Alpha blend"
                        : plannedMode === "inpaint"
                          ? "LaMa inpaint"
                          : "V1 + V2 dual brush → alpha if needed"}
                    </span>
                  </p>
                  {region && (
                    <p className="mt-1 font-mono">
                      {Math.round(region.width)}×{Math.round(region.height)}px
                    </p>
                  )}
                </div>
              )}
            </aside>
          </div>
        )}

        {step === "result" && imageUrl && resultUrl && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-white">Result</h2>
                <p className="text-sm text-gray-400">
                  {residualClean
                    ? "Re-check: no logo detected — clean"
                    : "Re-check: logo may still be present"}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setStep("edit")}
                  className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5"
                >
                  Edit again
                </button>
                <button
                  onClick={downloadResult}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
                >
                  Download PNG
                </button>
                <button
                  onClick={reset}
                  className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5"
                >
                  New image
                </button>
              </div>
            </div>

            {passLog.length > 0 && (
              <div className="glass rounded-xl p-4 text-xs text-gray-400">
                <p className="mb-2 font-semibold text-gray-300">
                  Removal passes ({passLog.length})
                </p>
                <ul className="space-y-1">
                  {passLog.map((p) => (
                    <li key={p.pass} className="font-mono text-[11px]">
                      #{p.pass}{" "}
                      <span
                        className={
                          p.method === "alpha" ? "text-emerald-400" : "text-sky-400"
                        }
                      >
                        {p.method}
                      </span>{" "}
                      — {p.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="glass overflow-hidden rounded-xl">
                <p className="border-b border-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Before
                </p>
                <img src={imageUrl} alt="Before" className="w-full object-contain" />
              </div>
              <div className="glass overflow-hidden rounded-xl shadow-glow">
                <p className="border-b border-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-emerald-400">
                  After
                </p>
                <img src={resultUrl} alt="After" className="w-full object-contain" />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
