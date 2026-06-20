import { useCallback, useEffect, useState } from "react";
import { MaskCanvas, ToolControls } from "./components/ImageEditor";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  type MaskRegion,
} from "./types";

type Step = "upload" | "edit" | "result";

export default function App() {
  const [step, setStep] = useState<Step>("upload");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [maskBlob, setMaskBlob] = useState<Blob | null>(null);
  const [region, setRegion] = useState<MaskRegion | null>(null);
  const [settings, setSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);

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

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleMaskChange = useCallback((blob: Blob | null, nextRegion: MaskRegion | null) => {
    setMaskBlob(blob);
    setRegion(nextRegion);
  }, []);

  const removeLogo = async () => {
    if (!imageFile || !maskBlob) {
      setError("Select or paint over the logo area first.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("image", imageFile);
      formData.append("mask", maskBlob, "mask.png");
      formData.append("featherPx", String(settings.featherPx));

      const response = await fetch("/api/inpaint", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
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
              Logo Remover
            </h1>
            <p className="text-sm text-gray-400">
              Select or paint the watermark · AI inpaint with LaMa
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
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
                  ? "API ready"
                  : "API offline"}
            </span>
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
              PNG, JPG, WEBP up to 20MB
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
                  <h2 className="font-semibold text-white">Mark the logo</h2>
                  <p className="text-sm text-gray-400">
                    Drag a box around the logo, or switch to Brush and paint over it.
                  </p>
                </div>
                <button
                  onClick={reset}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5"
                >
                  New image
                </button>
              </div>

              <MaskCanvas
                imageUrl={imageUrl}
                settings={settings}
                onMaskChange={handleMaskChange}
                disabled={loading}
              />

              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              )}

              <button
                onClick={removeLogo}
                disabled={loading || !maskBlob}
                className={`flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  maskBlob ? "bg-accent hover:bg-accent-hover shadow-glow" : "bg-accent/40"
                }`}
              >
                {loading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Removing watermark...
                  </>
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
              />

              <div className="glass rounded-xl p-4 text-xs leading-relaxed text-gray-400">
                <p className="mb-2 font-semibold text-gray-300">How it works</p>
                <ol className="list-decimal space-y-1 pl-4">
                  <li>Upload your image</li>
                  <li>Select box: drag around the logo</li>
                  <li>Or use Brush to paint over it</li>
                  <li>Hit Remove logo</li>
                </ol>
              </div>

              {region && (
                <div className="glass rounded-xl p-4 text-xs text-gray-400">
                  <p className="font-semibold text-gray-300">Selection</p>
                  <p className="mt-1 font-mono">
                    {Math.round(region.width)}×{Math.round(region.height)}px
                  </p>
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
                <p className="text-sm text-gray-400">Compare before and after</p>
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
