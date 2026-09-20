import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlurObject, DrawingDocument, Point, StampObject, StrokeObject, ToolSettings } from '../domain/drawing';
import { DEFAULT_BLUR_STRENGTH, STAMP_SIZE } from '../domain/drawing';
import { renderDocument } from '../engine/renderer';

type Props = {
  document: DrawingDocument;
  settings: ToolSettings;
  onCommitStroke: (stroke: StrokeObject) => void;
  onCommitBlur: (blur: BlurObject) => void;
  onCommitStamp: (stamp: StampObject) => void;
};

type ScreenPoint = { x: number; y: number };

type Viewport = { scale: number; x: number; y: number };

type PinchState = {
  dist0: number;
  mid0: ScreenPoint;
  scale0: number;
  tx0: number;
  ty0: number;
  rectLeft0: number;
  rectTop0: number;
  baseWidth: number;
  baseHeight: number;
};

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.5;
const IDENTITY_VIEWPORT: Viewport = { scale: 1, x: 0, y: 0 };

const distance = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: ScreenPoint, b: ScreenPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// OEK-04-BUG: `desynchronized: true` はcompositorの二重バッファ同期をスキップして
// レイテンシを下げるが、その代償として一部端末のGPU/compositorドライバでは
// 描画中に画面がちらつく（tearing/partial frame）ことが仕様上あり得る
// （Galaxy Tab S10 Liteでは無ちらつきだったが、HiGraceではペン・指の双方で
// 再現した）。ペン入力のレイテンシ低減は、この直後にあるrequestAnimationFrame
// によるフレームバッチ処理（queueLiveSegments/flushLiveSegments）が既に主要な
// 改善を担っているため、`desynchronized`は使わず標準の同期canvasへ戻す。
const get2dContext = (canvas: HTMLCanvasElement | null) => canvas?.getContext('2d') ?? null;

export function CanvasStage({ document, settings, onCommitStroke, onCommitBlur, onCommitStamp }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const activePointerId = useRef<number | null>(null);
  const [draft, setDraft] = useState<StrokeObject | BlurObject | null>(null);
  const liveStrokeRef = useRef<StrokeObject | null>(null);
  const pendingLivePointsRef = useRef<Point[]>([]);
  const liveFrameRef = useRef<number | null>(null);
  const lastPenAt = useRef(0);

  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT);
  const touchPoints = useRef<Map<number, ScreenPoint>>(new Map());
  const pinchRef = useRef<PinchState | null>(null);
  const pendingStampRef = useRef<{ pointerId: number; stamp: StampObject } | null>(null);

  const activeLayer = useMemo(
    () => document.layers.find((layer) => layer.id === document.activeLayerId),
    [document],
  );

  const activeLayerIsTopmostVisible = useMemo(() => {
    const index = document.layers.findIndex((layer) => layer.id === document.activeLayerId);
    if (index < 0) return false;
    return !document.layers.slice(index + 1).some((layer) => layer.visible);
  }, [document]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = get2dContext(canvas);
    if (!canvas || !ctx) return;
    renderDocument(ctx, document, draft);
  }, [document, draft]);

  useEffect(() => () => {
    if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
  }, []);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * document.width,
      y: ((event.clientY - rect.top) / rect.height) * document.height,
      pressure: event.pressure > 0 ? event.pressure : 0.5,
    };
  };

  const shouldIgnorePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'pen') {
      lastPenAt.current = performance.now();
      return false;
    }
    if (event.pointerType === 'touch' && performance.now() - lastPenAt.current < 900) return true;
    return !event.isPrimary;
  };

  const restoreCommittedDocument = () => {
    const canvas = canvasRef.current;
    const ctx = get2dContext(canvas);
    if (!canvas || !ctx) return;
    renderDocument(ctx, document, null);
  };

  const cancelLiveFrame = () => {
    if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
    liveFrameRef.current = null;
    pendingLivePointsRef.current = [];
  };

  const cancelActiveDraw = () => {
    if (activePointerId.current !== null) {
      const canvas = canvasRef.current;
      if (canvas?.hasPointerCapture(activePointerId.current)) {
        canvas.releasePointerCapture(activePointerId.current);
      }
      activePointerId.current = null;
    }
    if (liveStrokeRef.current) {
      cancelLiveFrame();
      liveStrokeRef.current = null;
      restoreCommittedDocument();
    }
    setDraft(null);
  };

  const cancelPendingStamp = () => {
    pendingStampRef.current = null;
  };

  const captureActiveTouches = (canvas: HTMLCanvasElement) => {
    for (const pointerId of touchPoints.current.keys()) {
      if (!canvas.hasPointerCapture(pointerId)) canvas.setPointerCapture(pointerId);
    }
  };

  const beginPinch = () => {
    const frame = frameRef.current;
    const points = Array.from(touchPoints.current.values());
    if (!frame || points.length < 2) return;
    const [p1, p2] = points;
    const rect = frame.getBoundingClientRect();
    pinchRef.current = {
      dist0: Math.max(1, distance(p1, p2)),
      mid0: midpoint(p1, p2),
      scale0: viewport.scale,
      tx0: viewport.x,
      ty0: viewport.y,
      rectLeft0: rect.left,
      rectTop0: rect.top,
      baseWidth: rect.width / viewport.scale,
      baseHeight: rect.height / viewport.scale,
    };
  };

  const updatePinch = () => {
    const pinch = pinchRef.current;
    const points = Array.from(touchPoints.current.values());
    if (!pinch || points.length < 2) return;
    const [p1, p2] = points;
    const dist1 = distance(p1, p2);
    const mid1 = midpoint(p1, p2);
    const newScale = clamp(pinch.scale0 * (dist1 / pinch.dist0), MIN_SCALE, MAX_SCALE);

    const localX = (pinch.mid0.x - pinch.rectLeft0) / pinch.scale0;
    const localY = (pinch.mid0.y - pinch.rectTop0) / pinch.scale0;
    let tx = mid1.x - pinch.rectLeft0 + pinch.tx0 - localX * newScale;
    let ty = mid1.y - pinch.rectTop0 + pinch.ty0 - localY * newScale;

    const maxPanX = Math.max(0, (pinch.baseWidth * (newScale - 1)) / 2);
    const maxPanY = Math.max(0, (pinch.baseHeight * (newScale - 1)) / 2);
    tx = clamp(tx, -2 * maxPanX, 0);
    ty = clamp(ty, -2 * maxPanY, 0);

    setViewport({ scale: newScale, x: tx, y: ty });
  };

  const endPinch = () => {
    pinchRef.current = null;
  };

  const resetViewport = () => setViewport(IDENTITY_VIEWPORT);

  const zoomByButton = (factor: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const nextScale = clamp(viewport.scale * factor, MIN_SCALE, MAX_SCALE);
    if (Math.abs(nextScale - MIN_SCALE) < 0.001) {
      resetViewport();
      return;
    }
    if (Math.abs(nextScale - viewport.scale) < 0.001) return;

    const rect = frame.getBoundingClientRect();
    const baseWidth = rect.width / viewport.scale;
    const baseHeight = rect.height / viewport.scale;
    const scaleRatio = nextScale / viewport.scale;
    let x = viewport.x * scaleRatio + (baseWidth * (1 - scaleRatio)) / 2;
    let y = viewport.y * scaleRatio + (baseHeight * (1 - scaleRatio)) / 2;
    x = clamp(x, -baseWidth * (nextScale - 1), 0);
    y = clamp(y, -baseHeight * (nextScale - 1), 0);
    setViewport({ scale: nextScale, x, y });
  };

  const canUseLiveStroke = (stroke: StrokeObject) =>
    activeLayerIsTopmostVisible
    && stroke.brush === 'pen'
    && Math.abs((activeLayer?.opacity ?? 1) - 1) < 0.001;

  const configureLiveStrokeContext = (ctx: CanvasRenderingContext2D, stroke: StrokeObject) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.size;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.globalAlpha = 1;
  };

  const drawLiveDot = (stroke: StrokeObject, point: Point) => {
    const ctx = get2dContext(canvasRef.current);
    if (!ctx) return;
    ctx.save();
    configureLiveStrokeContext(ctx, stroke);
    ctx.beginPath();
    ctx.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawLiveSegments = (stroke: StrokeObject, points: Point[]) => {
    if (!points.length) return;
    const ctx = get2dContext(canvasRef.current);
    const previous = stroke.points[stroke.points.length - 1];
    if (!ctx || !previous) return;

    ctx.save();
    configureLiveStrokeContext(ctx, stroke);
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    for (const point of points) ctx.lineTo(point.x, point.y);
    ctx.stroke();
    ctx.restore();
    stroke.points.push(...points);
  };

  const flushLiveSegments = () => {
    liveFrameRef.current = null;
    const stroke = liveStrokeRef.current;
    const points = pendingLivePointsRef.current;
    pendingLivePointsRef.current = [];
    if (!stroke || points.length === 0) return;
    drawLiveSegments(stroke, points);
  };

  const queueLiveSegments = (points: Point[]) => {
    if (!points.length) return;
    pendingLivePointsRef.current.push(...points);
    if (liveFrameRef.current === null) {
      liveFrameRef.current = requestAnimationFrame(flushLiveSegments);
    }
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerId.current !== null) return;
    if (settings.mode === 'eyedropper') return;
    if (shouldIgnorePointer(event) || !activeLayer || activeLayer.locked || !activeLayer.visible) return;
    event.preventDefault();

    if (settings.mode === 'stamp') {
      const point = pointFromEvent(event);
      const stamp: StampObject = {
        id: crypto.randomUUID(),
        type: 'stamp',
        stamp: settings.stampKind,
        x: point.x,
        y: point.y,
        size: STAMP_SIZE,
        color: settings.color,
      };
      if (event.pointerType === 'touch') {
        pendingStampRef.current = { pointerId: event.pointerId, stamp };
      } else {
        onCommitStamp(stamp);
      }
      return;
    }

    activePointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (settings.brush === 'blur') {
      setDraft({
        id: crypto.randomUUID(),
        type: 'blur',
        size: settings.size,
        strength: DEFAULT_BLUR_STRENGTH,
        points: [point],
      });
      return;
    }

    const stroke: StrokeObject = {
      id: crypto.randomUUID(),
      type: 'stroke',
      brush: settings.brush,
      color: settings.color,
      size: settings.size,
      points: [point],
    };

    if (canUseLiveStroke(stroke)) {
      cancelLiveFrame();
      liveStrokeRef.current = stroke;
      drawLiveDot(stroke, point);
      return;
    }

    setDraft(stroke);
  };

  const pointsFromMoveEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return coalesced.map((raw) => ({
      x: ((raw.clientX - rect.left) / rect.width) * document.width,
      y: ((raw.clientY - rect.top) / rect.height) * document.height,
      pressure: raw.pressure > 0 ? raw.pressure : 0.5,
    }));
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    event.preventDefault();
    const points = pointsFromMoveEvent(event);

    const liveStroke = liveStrokeRef.current;
    if (liveStroke) {
      queueLiveSegments(points);
      return;
    }

    setDraft((current) => current ? { ...current, points: [...current.points, ...points] } : current);
  };

  const stop = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    activePointerId.current = null;

    const liveStroke = liveStrokeRef.current;
    if (liveStroke) {
      if (liveFrameRef.current !== null) {
        cancelAnimationFrame(liveFrameRef.current);
        liveFrameRef.current = null;
      }
      flushLiveSegments();
      liveStrokeRef.current = null;
      onCommitStroke(liveStroke);
      return;
    }

    if (draft?.type === 'blur') onCommitBlur(draft);
    else if (draft?.type === 'stroke') onCommitStroke(draft);
    setDraft(null);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      if (touchPoints.current.size >= 2 && !touchPoints.current.has(event.pointerId)) {
        event.preventDefault();
        return;
      }
      touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPoints.current.size === 2) {
        event.preventDefault();
        cancelActiveDraw();
        cancelPendingStamp();
        captureActiveTouches(event.currentTarget);
        beginPinch();
        return;
      }
    }
    start(event);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch' && touchPoints.current.has(event.pointerId)) {
      touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchRef.current) {
        event.preventDefault();
        updatePinch();
        return;
      }
    }
    move(event);
  };

  const endTouch = (event: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
    if (event.pointerType !== 'touch') return false;
    touchPoints.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pinchRef.current) {
      if (touchPoints.current.size < 2) endPinch();
      return true;
    }
    if (pendingStampRef.current?.pointerId === event.pointerId) {
      const pending = pendingStampRef.current;
      pendingStampRef.current = null;
      if (commit) onCommitStamp(pending.stamp);
      return true;
    }
    return false;
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!endTouch(event, true)) stop(event);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!endTouch(event, false)) stop(event);
  };

  return (
    <div className="canvas-area">
      <div
        ref={frameRef}
        className="canvas-frame"
        style={{
          aspectRatio: `${document.width} / ${document.height}`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: '0 0',
        }}
      >
        <canvas
          ref={canvasRef}
          width={document.width}
          height={document.height}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onContextMenu={(event) => event.preventDefault()}
        />
      </div>
      <div className="zoom-controls" aria-label="ズームそうさ">
        <button
          type="button"
          className="zoom-step"
          onClick={() => zoomByButton(1 / ZOOM_STEP)}
          disabled={viewport.scale <= MIN_SCALE + 0.001}
          aria-label="ちいさくする"
        >
          −
        </button>
        <button
          type="button"
          className="zoom-reset"
          onClick={resetViewport}
          disabled={viewport.scale <= MIN_SCALE + 0.001}
          aria-label="ひろさを もとに もどす"
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <button
          type="button"
          className="zoom-step"
          onClick={() => zoomByButton(ZOOM_STEP)}
          disabled={viewport.scale >= MAX_SCALE - 0.001}
          aria-label="おおきくする"
        >
          ＋
        </button>
      </div>
    </div>
  );
}
