"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClickPoint, EditorSettings, MaskRegion } from "@/types";
import {
  clampRegion,
  clientToImagePoint,
  createEmptyMaskCanvas,
  displayDeltaToImageDelta,
  drawRegionOnMask,
  getImageStageBounds,
  imageBrushRadius,
  imageToDisplayRect,
  maskCanvasToBlob,
  maskHasContent,
  paintBrushStroke,
  paintBrushStrokeDisplay,
  regionFromPoints,
  syncBrushOverlayFromMask,
  type RenderedImageBounds,
} from "@/lib/maskGeometry";
import { CORNER_SEARCH_FRACTION, getGeminiSearchZone } from "@/lib/geminiSearchZone";

interface MaskCanvasProps {
  imageUrl: string;
  settings: EditorSettings;
  onMaskChange: (maskBlob: Blob | null, region: MaskRegion | null) => void;
  detectedRegion?: MaskRegion | null;
  showSearchGuides?: boolean;
  disabled?: boolean;
}

export function MaskCanvas({
  imageUrl,
  settings,
  onMaskChange,
  detectedRegion = null,
  showSearchGuides = true,
  disabled = false,
}: MaskCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  const [bounds, setBounds] = useState<RenderedImageBounds | null>(null);
  const [region, setRegion] = useState<MaskRegion | null>(null);
  const [hasMask, setHasMask] = useState(false);
  const [marqueeDraft, setMarqueeDraftState] = useState<MaskRegion | null>(null);
  const marqueeDraftRef = useRef<MaskRegion | null>(null);
  const [movingBox, setMovingBox] = useState(false);

  const setMarqueeDraft = (value: MaskRegion | null) => {
    marqueeDraftRef.current = value;
    setMarqueeDraftState(value);
  };

  const interactionRef = useRef({
    mode: "idle" as "idle" | "marquee" | "brush" | "move",
    start: null as ClickPoint | null,
    lastBrush: null as ClickPoint | null,
    moveOrigin: null as { x: number; y: number; region: MaskRegion } | null,
  });

  const refreshBounds = useCallback(() => {
    const img = imgRef.current;
    if (!img?.naturalWidth) return;
    setBounds(getImageStageBounds(img));
  }, []);

  const initMaskCanvas = useCallback((width: number, height: number) => {
    const { canvas, ctx } = createEmptyMaskCanvas(width, height);
    maskCanvasRef.current = canvas;
    maskCtxRef.current = ctx;
    setHasMask(false);
    setRegion(null);
    setMarqueeDraft(null);
  }, []);

  const clearOverlayCanvas = useCallback(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const octx = overlay.getContext("2d");
    if (!octx) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }, []);

  const redrawOverlay = useCallback(() => {
    const overlay = overlayCanvasRef.current;
    const maskCtx = maskCtxRef.current;
    const img = imgRef.current;
    if (!overlay || !maskCtx || !img || !bounds) return;

    const w = img.clientWidth;
    const h = img.clientHeight;
    if (!w || !h) return;

    overlay.width = w;
    overlay.height = h;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;

    const octx = overlay.getContext("2d");
    if (!octx) return;

    octx.clearRect(0, 0, w, h);

    if (showSearchGuides && img.naturalWidth && img.naturalHeight) {
      const zone = getGeminiSearchZone(img.naturalWidth, img.naturalHeight);
      const scaleX = w / img.naturalWidth;
      const scaleY = h / img.naturalHeight;
      const cornerX = img.naturalWidth * (1 - CORNER_SEARCH_FRACTION) * scaleX;
      const cornerY = img.naturalHeight * (1 - CORNER_SEARCH_FRACTION) * scaleY;
      const search = zone.searchRegion;

      octx.fillStyle = "rgba(99, 102, 241, 0.1)";
      octx.fillRect(
        search.x1 * scaleX,
        search.y1 * scaleY,
        search.width * scaleX,
        search.height * scaleY
      );

      octx.setLineDash([8, 5]);
      octx.lineWidth = 1;
      octx.strokeStyle = "rgba(99, 102, 241, 0.65)";
      octx.beginPath();
      octx.moveTo(cornerX, 0);
      octx.lineTo(cornerX, h);
      octx.moveTo(0, cornerY);
      octx.lineTo(w, cornerY);
      octx.stroke();

      octx.setLineDash([]);
      octx.strokeStyle = "rgba(99, 102, 241, 0.85)";
      octx.lineWidth = 2;
      octx.strokeRect(
        search.x1 * scaleX,
        search.y1 * scaleY,
        search.width * scaleX,
        search.height * scaleY
      );
    }

    if (settings.tool === "brush" && maskHasContent(maskCtx)) {
      syncBrushOverlayFromMask(maskCtx, octx);
    }
  }, [bounds, settings.tool, showSearchGuides]);

  const publishMask = useCallback(
    async (nextRegion: MaskRegion | null = region) => {
      const canvas = maskCanvasRef.current;
      const ctx = maskCtxRef.current;
      if (!canvas || !ctx) {
        onMaskChange(null, null);
        return;
      }

      const painted = maskHasContent(ctx);
      setHasMask(painted);

      if (!painted) {
        onMaskChange(null, null);
        return;
      }

      const blob = await maskCanvasToBlob(canvas);
      onMaskChange(blob, nextRegion);
    },
    [onMaskChange, region]
  );

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    const handleLoad = () => {
      initMaskCanvas(img.naturalWidth, img.naturalHeight);
      refreshBounds();
    };

    if (img.complete && img.naturalWidth) handleLoad();
    img.addEventListener("load", handleLoad);

    return () => img.removeEventListener("load", handleLoad);
  }, [imageUrl, initMaskCanvas, refreshBounds]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const observer = new ResizeObserver(() => {
      refreshBounds();
      redrawOverlay();
    });
    observer.observe(stage);
    window.addEventListener("resize", refreshBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refreshBounds);
    };
  }, [refreshBounds, redrawOverlay]);

  useEffect(() => {
    redrawOverlay();
  }, [redrawOverlay, region, marqueeDraft, hasMask]);

  const clearMask = () => {
    const img = imgRef.current;
    if (!img?.naturalWidth) return;
    initMaskCanvas(img.naturalWidth, img.naturalHeight);
    clearOverlayCanvas();
    onMaskChange(null, null);
  };

  const applyMarqueeRegion = useCallback(
    async (next: MaskRegion) => {
      const img = imgRef.current;
      const ctx = maskCtxRef.current;
      const canvas = maskCanvasRef.current;
      if (!img || !ctx || !canvas || !bounds) return;

      const scaleX = bounds.renderedWidth / bounds.naturalWidth;
      const scaleY = bounds.renderedHeight / bounds.naturalHeight;
      const displayW = next.width * scaleX;
      const displayH = next.height * scaleY;

      if (displayW < 6 || displayH < 6) {
        return;
      }

      const clamped = clampRegion(next, img.naturalWidth, img.naturalHeight);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, img.naturalWidth, img.naturalHeight);
      drawRegionOnMask(ctx, clamped);

      const blob = await maskCanvasToBlob(canvas);
      if (!blob) return;

      setRegion(clamped);
      setMarqueeDraft(null);
      setHasMask(true);
      onMaskChange(blob, clamped);
    },
    [bounds, onMaskChange]
  );

  useEffect(() => {
    if (!detectedRegion || !bounds || !imgRef.current?.naturalWidth) return;
    void applyMarqueeRegion(detectedRegion);
  }, [detectedRegion, bounds, applyMarqueeRegion]);

  const pointerToImage = (clientX: number, clientY: number): ClickPoint | null => {
    const stage = stageRef.current;
    if (!stage || !bounds) return null;
    return clientToImagePoint(clientX, clientY, stage, bounds);
  };

  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const applyMarqueeRegionRef = useRef(applyMarqueeRegion);
  applyMarqueeRegionRef.current = applyMarqueeRegion;
  const publishMaskRef = useRef(publishMask);
  publishMaskRef.current = publishMask;

  const attachDragListeners = () => {
    const onMove = (event: PointerEvent) => {
      const img = imgRef.current;
      const b = boundsRef.current;
      const s = interactionRef.current;
      if (!img || !b || s.mode === "idle") return;

      const stage = stageRef.current;
      if (!stage) return;
      const point = clientToImagePoint(event.clientX, event.clientY, stage, b);
      if (!point) return;

      if (s.mode === "marquee" && s.start) {
        setMarqueeDraft(regionFromPoints(s.start, point));
        return;
      }

      if (s.mode === "move" && s.moveOrigin) {
        const { dx, dy } = displayDeltaToImageDelta(
          event.clientX - s.moveOrigin.x,
          event.clientY - s.moveOrigin.y,
          b
        );
        const moved = clampRegion(
          {
            ...s.moveOrigin.region,
            x1: s.moveOrigin.region.x1 + dx,
            y1: s.moveOrigin.region.y1 + dy,
            x2: s.moveOrigin.region.x1 + dx + s.moveOrigin.region.width,
            y2: s.moveOrigin.region.y1 + dy + s.moveOrigin.region.height,
          },
          img.naturalWidth,
          img.naturalHeight
        );
        setMarqueeDraft(moved);
        return;
      }

      if (s.mode === "brush" && s.lastBrush) {
        const ctx = maskCtxRef.current;
        const overlay = overlayCanvasRef.current;
        if (!ctx || !overlay) return;
        const octx = overlay.getContext("2d");
        if (!octx) return;

        const radius = imageBrushRadius(settingsRef.current.brushSize, b);
        paintBrushStroke(ctx, s.lastBrush, point, radius);
        paintBrushStrokeDisplay(octx, s.lastBrush, point, radius, b);
        interactionRef.current.lastBrush = point;
        setHasMask(true);
      }
    };

    const onUp = (event: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      const s = interactionRef.current;
      const stage = stageRef.current;
      const b = boundsRef.current;

      if (s.mode === "marquee" && s.start && stage && b) {
        const end = clientToImagePoint(event.clientX, event.clientY, stage, b);
        const finalRegion = end
          ? regionFromPoints(s.start, end)
          : marqueeDraftRef.current;
        if (finalRegion) void applyMarqueeRegionRef.current(finalRegion);
      } else if (s.mode === "move") {
        const draft = marqueeDraftRef.current;
        if (draft) void applyMarqueeRegionRef.current(draft);
      } else if (s.mode === "brush") {
        void publishMaskRef.current(null);
      }

      interactionRef.current = {
        mode: "idle",
        start: null,
        lastBrush: null,
        moveOrigin: null,
      };
      setMovingBox(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !bounds) return;

    const point = pointerToImage(event.clientX, event.clientY);
    if (!point) return;

    event.preventDefault();

    if (settings.tool === "brush") {
      const ctx = maskCtxRef.current;
      const overlay = overlayCanvasRef.current;
      if (!ctx || !overlay) return;
      const octx = overlay.getContext("2d");
      if (!octx) return;

      const radius = imageBrushRadius(settings.brushSize, bounds);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      paintBrushStrokeDisplay(octx, point, point, radius, bounds);
      interactionRef.current = {
        mode: "brush",
        start: point,
        lastBrush: point,
        moveOrigin: null,
      };
      setHasMask(true);
      setMovingBox(true);
      attachDragListeners();
      return;
    }

    if (
      settings.tool === "marquee" &&
      region &&
      point.x >= region.x1 &&
      point.x <= region.x2 &&
      point.y >= region.y1 &&
      point.y <= region.y2
    ) {
      interactionRef.current = {
        mode: "move",
        start: point,
        lastBrush: null,
        moveOrigin: { x: event.clientX, y: event.clientY, region },
      };
      setMovingBox(true);
      attachDragListeners();
      return;
    }

    interactionRef.current = {
      mode: "marquee",
      start: point,
      lastBrush: null,
      moveOrigin: null,
    };
    setMarqueeDraft(regionFromPoints(point, point));
    setMovingBox(true);
    attachDragListeners();
  };

  const cursorClass =
    settings.tool === "brush"
      ? "cursor-crosshair"
      : movingBox
        ? "cursor-move"
        : "cursor-crosshair";

  const activeRegion =
    settings.tool === "marquee" ? (marqueeDraft ?? region) : null;

  const selectionBoxStyle =
    activeRegion && bounds ? imageToDisplayRect(activeRegion, bounds) : null;

  return (
    <div className="space-y-2">
      <div className="flex justify-center rounded-xl border border-white/10 bg-black/40 p-1">
        <div
          ref={stageRef}
          className={`relative inline-block leading-none ${disabled ? "opacity-70" : ""}`}
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt="Upload preview"
            className="block max-h-[70vh] max-w-full select-none"
            style={{ width: "auto", height: "auto", maxHeight: "70vh" }}
            draggable={false}
          />

          <canvas
            ref={overlayCanvasRef}
            className="pointer-events-none absolute left-0 top-0 block"
          />

          {selectionBoxStyle && (
            <div
              className={`pointer-events-none absolute box-border ${
                marqueeDraft
                  ? "border-2 border-dashed border-red-400 bg-red-500/30"
                  : "border-2 border-red-400 bg-red-500/35 shadow-[0_0_16px_rgba(248,113,113,0.35)]"
              }`}
              style={{
                left: selectionBoxStyle.left,
                top: selectionBoxStyle.top,
                width: selectionBoxStyle.width,
                height: selectionBoxStyle.height,
              }}
            >
              <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-red-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                {marqueeDraft ? "Selecting…" : "Remove this area"}
              </span>
            </div>
          )}

          {bounds && bounds.renderedWidth > 0 && (
            <div
              className={`absolute inset-0 touch-none ${disabled ? "pointer-events-none" : cursorClass}`}
              onPointerDown={handlePointerDown}
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-400">
          {settings.tool === "marquee"
            ? "Click and drag to select the logo. Drag the box to reposition."
            : "Paint over the logo with your cursor."}
          {showSearchGuides && (
            <span className="mt-1 block text-[11px] text-indigo-300/80">
              Blue lines = 12% corner boundary · Blue box = auto-detect zone
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={clearMask}
          disabled={disabled || !hasMask}
          className="rounded-lg border border-white/10 px-3 py-1 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-40"
        >
          Clear selection
        </button>
      </div>
    </div>
  );
}

interface ToolControlsProps {
  settings: EditorSettings;
  onChange: (settings: EditorSettings) => void;
  disabled?: boolean;
}

export function ToolControls({ settings, onChange, disabled }: ToolControlsProps) {
  const update = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="glass space-y-4 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-white">Selection tool</h3>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => update("tool", "marquee")}
          className={`rounded-lg border px-3 py-2 text-sm transition ${
            settings.tool === "marquee"
              ? "border-accent bg-accent/20 text-white"
              : "border-white/10 text-gray-300 hover:bg-white/5"
          }`}
        >
          Select box
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => update("tool", "brush")}
          className={`rounded-lg border px-3 py-2 text-sm transition ${
            settings.tool === "brush"
              ? "border-accent bg-accent/20 text-white"
              : "border-white/10 text-gray-300 hover:bg-white/5"
          }`}
        >
          Brush
        </button>
      </div>

      {settings.tool === "brush" && (
        <label className="block space-y-2">
          <div className="flex justify-between text-xs text-gray-400">
            <span>Brush size</span>
            <span>{settings.brushSize}px</span>
          </div>
          <input
            type="range"
            min={8}
            max={80}
            step={2}
            value={settings.brushSize}
            disabled={disabled}
            onChange={(e) => update("brushSize", Number(e.target.value))}
            className="w-full accent-accent"
          />
        </label>
      )}

      <label className="block space-y-2">
        <div className="flex justify-between text-xs text-gray-400">
          <span>Edge feather</span>
          <span>{settings.featherPx}px</span>
        </div>
        <input
          type="range"
          min={0}
          max={40}
          step={1}
          value={settings.featherPx}
          disabled={disabled}
          onChange={(e) => update("featherPx", Number(e.target.value))}
          className="w-full accent-accent"
        />
      </label>

      <div className="rounded-lg border border-white/5 bg-black/20 p-3 text-xs leading-relaxed text-gray-400">
        <p className="font-medium text-gray-300">Select box</p>
        <p className="mt-1">Drag a rectangle around the logo, or use Re-detect.</p>
        <p className="mt-2 font-medium text-gray-300">Brush</p>
        <p className="mt-1">Paint directly over the watermark for precise control.</p>
      </div>
    </div>
  );
}
