"use client";

import type { DetectionDebugMeta, DetectionDebugStep } from "@/lib/geminiDetectDebug";
import { downloadDebugSteps } from "@/lib/geminiDetectDebug";

interface DetectionFlowViewerProps {
  steps: DetectionDebugStep[];
  meta: DetectionDebugMeta;
}

export function DetectionFlowViewer({ steps, meta }: DetectionFlowViewerProps) {
  if (steps.length === 0) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Detection flow</h2>
          <p className="text-sm text-gray-400">
            Step-by-step images from upload → search → match → final mask.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void downloadDebugSteps(steps)}
          className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-200 hover:bg-white/10"
        >
          Download all steps (ZIP)
        </button>
      </div>

      <div className="glass grid gap-3 rounded-xl p-4 text-xs text-gray-400 sm:grid-cols-2 lg:grid-cols-4">
        <p>
          <span className="text-gray-500">Input:</span>{" "}
          <span className="font-mono text-gray-200">
            {meta.naturalWidth}×{meta.naturalHeight}px
          </span>
        </p>
        <p>
          <span className="text-gray-500">Search:</span>{" "}
          <span className="font-mono text-gray-200">
            {meta.searchWidth}×{meta.searchHeight}px
          </span>
        </p>
        <p>
          <span className="text-gray-500">Zone:</span>{" "}
          <span className="font-mono text-gray-200">
            {meta.matchedZoneFraction !== null
              ? `${Math.round(meta.matchedZoneFraction * 100)}% corner`
              : "—"}
          </span>
        </p>
        <p>
          <span className="text-gray-500">Result:</span>{" "}
          <span
            className={`font-mono ${meta.found ? "text-emerald-400" : "text-red-300"}`}
          >
            {meta.found
              ? `${Math.round((meta.confidence ?? 0) * 100)}% · ${Math.round(meta.region?.width ?? 0)}×${Math.round(meta.region?.height ?? 0)}px`
              : "Not found"}
          </span>
        </p>
      </div>

      <ol className="space-y-8">
        {steps.map((step, index) => (
          <li key={step.id} className="glass overflow-hidden rounded-xl">
            <div className="border-b border-white/5 px-4 py-3">
              <p className="text-sm font-semibold text-white">
                {index + 1}. {step.title.replace(/^\d+\.\s*/, "")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">{step.description}</p>
              <p className="mt-1 font-mono text-[11px] text-gray-500">
                {step.width}×{step.height}px · {step.id}
              </p>
            </div>
            <div className="bg-black/30 p-3">
              <img
                src={step.imageDataUrl}
                alt={step.title}
                className="mx-auto max-h-[520px] w-full object-contain"
              />
            </div>
            <div className="border-t border-white/5 px-4 py-2">
              <a
                href={step.imageDataUrl}
                download={`step${index + 1}.png`}
                className="text-xs text-accent hover:underline"
              >
                Download this step
              </a>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
