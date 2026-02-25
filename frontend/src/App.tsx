import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  CandlestickData,
  ColorType,
  createChart,
  IChartApi,
  ISeriesApi,
  LineData,
  Logical,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

type Interval = "5m" | "15m" | "1h" | "4h" | "1D" | "1W" | "1M";
type Tool = "none" | "hline" | "rect" | "fibo" | "pricerange" | "longpos" | "shortpos" | "replay-start";

type Candle = {
  symbol: string;
  interval: Interval;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type DrawingPoint = {
  time: number;
  price: number;
};

type Drawing = {
  id: number;
  symbol: string;
  type: "hline" | "rect" | "fibo" | "pricerange" | "longpos" | "shortpos";
  points: DrawingPoint[];
  style: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type PositionHandle = "tp" | "sl" | "time";

type LineStyleOption = "solid" | "dashed";
type MondayRange = {
  weekStartMs: number;
  weekEndMs: number;
  mondayHigh: number;
  mondayLow: number;
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const SYMBOL = "BTCUSDT";
const INTERVALS: Interval[] = ["5m", "15m", "1h", "4h", "1D", "1W", "1M"];
const SPEEDS = [1, 2, 5, 10];
const FIB_LEVELS = [0, 0.25, 0.5, 0.75, 1];
const INTERVAL_MS: Record<Interval, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

const api = axios.create({ baseURL: API_URL });

function toUtcTimestamp(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function parsePeriods(raw: string): number[] {
  return raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Math.floor(v));
}

function parseFiboLevels(raw: string): number[] {
  const parsed = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v));

  if (parsed.length === 0) {
    return [...FIB_LEVELS];
  }

  return Array.from(new Set(parsed)).sort((a, b) => a - b);
}

function hexToRgba(hex: string, alpha: number): string {
  const sanitized = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(sanitized)) {
    return `rgba(96, 165, 250, ${alpha})`;
  }

  const r = Number.parseInt(sanitized.slice(0, 2), 16);
  const g = Number.parseInt(sanitized.slice(2, 4), 16);
  const b = Number.parseInt(sanitized.slice(4, 6), 16);
  const safeAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
}

function startOfUtcMonday(timeMs: number): number {
  const d = new Date(timeMs);
  const day = d.getUTCDay(); // 0 Sun ... 6 Sat
  const diffToMonday = (day + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.getTime();
}

function rgbaToHexOpacity(input: string): { hex: string; opacity: number } {
  const m = input
    .replace(/\s+/g, "")
    .match(/^rgba?\((\d+),(\d+),(\d+)(?:,([0-9.]+))?\)$/i);

  if (!m) {
    return { hex: "#60a5fa", opacity: 0.2 };
  }

  const r = Math.min(255, Math.max(0, Number(m[1])));
  const g = Math.min(255, Math.max(0, Number(m[2])));
  const b = Math.min(255, Math.max(0, Number(m[3])));
  const a = m[4] !== undefined ? Number(m[4]) : 1;

  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return {
    hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`,
    opacity: Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 0.2,
  };
}

function computeEma(candles: Candle[], period: number): LineData<UTCTimestamp>[] {
  if (candles.length === 0 || period <= 0) {
    return [];
  }

  const multiplier = 2 / (period + 1);
  const result: LineData<UTCTimestamp>[] = [];
  let ema = candles[0].close;

  for (const candle of candles) {
    ema = (candle.close - ema) * multiplier + ema;
    result.push({
      time: toUtcTimestamp(candle.openTime),
      value: Number(ema.toFixed(4)),
    });
  }

  return result;
}

function timeToMs(time: Time | null): number | null {
  if (time === null) {
    return null;
  }
  if (typeof time === "number") {
    return time * 1000;
  }
  return null;
}

function nearestCandleIndex(candles: Candle[], targetTimeMs: number): number {
  if (candles.length === 0) {
    return -1;
  }

  let best = 0;
  let bestDiff = Math.abs(candles[0].openTime - targetTimeMs);

  for (let i = 1; i < candles.length; i += 1) {
    const diff = Math.abs(candles[i].openTime - targetTimeMs);
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }

  return best;
}

export default function App() {
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingToolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarDragRef = useRef<{ active: boolean; startX: number; startY: number; originX: number; originY: number }>({
    active: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  });
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const emaSeriesRef = useRef<Map<number, ISeriesApi<"Line">>>(new Map());
  const drawOverlayRef = useRef<() => void>(() => {});
  const hitTestDrawingRef = useRef<(x: number, y: number) => Drawing | null>(() => null);
  const hitTestPositionHandleRef = useRef<(x: number, y: number) => PositionHandle | null>(() => null);

  const drawingsRef = useRef<Drawing[]>([]);
  const pendingPointRef = useRef<DrawingPoint | null>(null);
  const hoverPointRef = useRef<DrawingPoint | null>(null);
  const toolRef = useRef<Tool>("none");
  const selectedDrawingIdRef = useRef<number | null>(null);
  const selectedDrawingRef = useRef<Drawing | null>(null);
  const guideRef = useRef<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });

  const [interval, setInterval] = useState<Interval>("15m");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [tool, setTool] = useState<Tool>("none");
  const [pendingPoint, setPendingPoint] = useState<DrawingPoint | null>(null);
  const [hoverPoint, setHoverPoint] = useState<DrawingPoint | null>(null);
  const [didInitialFit, setDidInitialFit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [speed, setSpeed] = useState<number>(2);
  const [replayStartIndex, setReplayStartIndex] = useState<number | null>(null);
  const [currentReplayIndex, setCurrentReplayIndex] = useState<number | null>(null);
  const [replayRunning, setReplayRunning] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [showMondayLevels, setShowMondayLevels] = useState(false);

  const [selectedDrawingId, setSelectedDrawingId] = useState<number | null>(null);
  const [selectedDrawingAnchor, setSelectedDrawingAnchor] = useState<{ x: number; y: number } | null>(null);
  const [drawingToolbarPos, setDrawingToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [manualToolbarPos, setManualToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<PositionHandle | null>(null);
  const [editorColor, setEditorColor] = useState("#60a5fa");
  const [editorLineWidth, setEditorLineWidth] = useState(2);
  const [editorLineStyle, setEditorLineStyle] = useState<LineStyleOption>("solid");
  const [editorRectFillColor, setEditorRectFillColor] = useState("#60a5fa");
  const [editorRectFillOpacity, setEditorRectFillOpacity] = useState(0.2);
  const [editorFiboLevels, setEditorFiboLevels] = useState("0,0.25,0.5,0.75,1");

  const [emaInput, setEmaInput] = useState<string>(() => localStorage.getItem("emaPeriods") ?? "20,50,200");
  const [emaPeriods, setEmaPeriods] = useState<number[]>(() => parsePeriods(localStorage.getItem("emaPeriods") ?? "20,50,200"));

  const displayedCandles = useMemo(() => {
    if (currentReplayIndex === null) {
      return candles;
    }
    return candles.slice(0, currentReplayIndex + 1);
  }, [candles, currentReplayIndex]);

  const mondayRanges = useMemo<MondayRange[]>(() => {
    if (displayedCandles.length === 0) {
      return [];
    }

    const grouped = new Map<number, Candle[]>();
    for (const c of displayedCandles) {
      const weekStart = startOfUtcMonday(c.openTime);
      const bucket = grouped.get(weekStart);
      if (bucket) {
        bucket.push(c);
      } else {
        grouped.set(weekStart, [c]);
      }
    }

    const stepMs = INTERVAL_MS[interval];
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const ranges: MondayRange[] = [];

    for (const [weekStartMs, weekCandles] of grouped.entries()) {
      const mondayCandles = weekCandles.filter((c) => {
        const day = new Date(c.openTime).getUTCDay();
        return day === 1;
      });

      if (mondayCandles.length === 0) {
        continue;
      }

      let mondayHigh = mondayCandles[0].high;
      let mondayLow = mondayCandles[0].low;
      for (const c of mondayCandles) {
        if (c.high > mondayHigh) mondayHigh = c.high;
        if (c.low < mondayLow) mondayLow = c.low;
      }

      ranges.push({
        weekStartMs,
        weekEndMs: weekStartMs + oneWeekMs - stepMs,
        mondayHigh,
        mondayLow,
      });
    }

    ranges.sort((a, b) => a.weekStartMs - b.weekStartMs);
    return ranges;
  }, [displayedCandles, interval]);

  const replayStartTimeMs = replayStartIndex !== null ? candles[replayStartIndex]?.openTime ?? null : null;
  const isReplayPrepared = replayStartIndex !== null;
  const isReplayInProgress = currentReplayIndex !== null;
  const selectedDrawing = useMemo(
    () => (selectedDrawingId === null ? null : drawings.find((d) => d.id === selectedDrawingId) ?? null),
    [drawings, selectedDrawingId]
  );
  const isPositionSelected = selectedDrawing?.type === "longpos" || selectedDrawing?.type === "shortpos";
  const isCanvasInteractive = tool !== "none" || isPositionSelected || draggingHandle !== null;

  const centerReplayViewport = (idx: number) => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    chart.timeScale().setVisibleLogicalRange({
      from: idx - 70,
      to: idx + 70,
    });
  };

  const clampToolbarPos = (x: number, y: number): { x: number; y: number } | null => {
    const wrap = chartWrapRef.current;
    if (!wrap) {
      return null;
    }

    const pad = 8;
    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const toolbarW = drawingToolbarRef.current?.offsetWidth ?? 420;
    const toolbarH = drawingToolbarRef.current?.offsetHeight ?? 42;

    return {
      x: Math.min(Math.max(pad, x), Math.max(pad, wrapW - toolbarW - pad)),
      y: Math.min(Math.max(pad, y), Math.max(pad, wrapH - toolbarH - pad)),
    };
  };

  useEffect(() => {
    const chartContainer = chartContainerRef.current;
    const canvas = canvasRef.current;
    if (!chartContainer || !canvas) {
      return;
    }

    const chart = createChart(chartContainer, {
      autoSize: true,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
      },
      layout: {
        background: { type: ColorType.Solid, color: "#0b1020" },
        textColor: "#d8def5",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.08)" },
        horzLines: { color: "rgba(255,255,255,0.08)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.25)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.25)",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { visible: false, color: "rgba(120, 170, 255, 0.45)" },
        horzLine: { visible: false, color: "rgba(120, 170, 255, 0.45)" },
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#16c784",
      downColor: "#ea3943",
      borderVisible: false,
      wickUpColor: "#16c784",
      wickDownColor: "#ea3943",
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const resizeObserver = new ResizeObserver(() => {
      const rect = chartContainer.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * window.devicePixelRatio);
      canvas.height = Math.floor(rect.height * window.devicePixelRatio);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      drawOverlayRef.current();
    });

    resizeObserver.observe(chartContainer);

    chart.timeScale().subscribeVisibleTimeRangeChange(() => drawOverlayRef.current());
    chart.subscribeCrosshairMove((param) => {
      if (toolRef.current !== "none") {
        return;
      }

      const point = param.point;
      if (!point || point.x < 0 || point.y < 0) {
        guideRef.current = { x: 0, y: 0, visible: false };
        drawOverlayRef.current();
        return;
      }

      guideRef.current = { x: point.x, y: point.y, visible: true };
      drawOverlayRef.current();
    });
    chart.subscribeClick((param) => {
      if (toolRef.current !== "none") {
        return;
      }
      const point = param.point;
      if (!point) {
        setSelectedDrawingId(null);
        return;
      }
      const hit = hitTestDrawingRef.current(point.x, point.y);
      setSelectedDrawingId(hit?.id ?? null);
    });

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      emaSeriesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const twoYearsAgo = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
        const [candlesRes, drawingsRes] = await Promise.all([
          api.get<Candle[]>("/api/candles", {
            params: { symbol: SYMBOL, interval, from: twoYearsAgo, to: Date.now() },
          }),
          api.get<Drawing[]>("/api/drawings", { params: { symbol: SYMBOL } }),
        ]);

        setCandles(candlesRes.data);
        setDrawings(drawingsRes.data);
        setReplayStartIndex(null);
        setCurrentReplayIndex(null);
        setReplayRunning(false);
        setDidInitialFit(false);
        setSelectedDrawingId(null);
        setSelectedDrawingAnchor(null);
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [interval]);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !chart) {
      return;
    }

    const data: CandlestickData<UTCTimestamp>[] = displayedCandles.map((c) => ({
      time: toUtcTimestamp(c.openTime),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    candleSeries.setData(data);

    emaSeriesRef.current.forEach((series) => {
      chart.removeSeries(series);
    });
    emaSeriesRef.current.clear();

    const palette = ["#fbbf24", "#67e8f9", "#f472b6", "#86efac", "#fca5a5", "#c4b5fd"];

    emaPeriods.forEach((period, idx) => {
      const lineSeries = chart.addLineSeries({
        color: palette[idx % palette.length],
        lineWidth: 2,
        priceLineVisible: false,
      });
      lineSeries.setData(computeEma(displayedCandles, period));
      emaSeriesRef.current.set(period, lineSeries);
    });

    if (!didInitialFit && displayedCandles.length > 0) {
      chart.timeScale().fitContent();
      setDidInitialFit(true);
    }

    drawOverlay();
  }, [displayedCandles, emaPeriods, didInitialFit]);

  useEffect(() => {
    if (!replayRunning || currentReplayIndex === null) {
      return;
    }

    const timer = window.setInterval(() => {
      setCurrentReplayIndex((prev) => {
        if (prev === null) {
          return prev;
        }
        if (prev >= candles.length - 1) {
          setReplayRunning(false);
          return prev;
        }
        return prev + 1;
      });
    }, Math.max(80, Math.floor(1000 / speed)));

    return () => window.clearInterval(timer);
  }, [replayRunning, currentReplayIndex, speed, candles.length]);

  useEffect(() => {
    drawingsRef.current = drawings;
    pendingPointRef.current = pendingPoint;
    hoverPointRef.current = hoverPoint;
    toolRef.current = tool;
    selectedDrawingIdRef.current = selectedDrawingId;
    drawOverlayRef.current();
  }, [drawings, pendingPoint, hoverPoint, tool, replayStartIndex, interval, candles, currentReplayIndex, selectedDrawingId, showMondayLevels, mondayRanges]);

  useEffect(() => {
    if (selectedDrawingId === null) {
      return;
    }
    const exists = drawings.some((d) => d.id === selectedDrawingId);
    if (!exists) {
      setSelectedDrawingId(null);
      setSelectedDrawingAnchor(null);
    }
  }, [drawings, selectedDrawingId]);

  useEffect(() => {
    setManualToolbarPos(null);
  }, [selectedDrawingId]);

  useEffect(() => {
    selectedDrawingRef.current = selectedDrawing;
    if (!selectedDrawing) {
      return;
    }

    const color = String(selectedDrawing.style?.color ?? "#60a5fa");
    const width = Number(selectedDrawing.style?.lineWidth ?? 2);
    const lineStyle = String(selectedDrawing.style?.lineStyle ?? "solid") === "dashed" ? "dashed" : "solid";
    const fillColorRaw = String(selectedDrawing.style?.fillColor ?? "rgba(96, 165, 250, 0.2)");
    const fill = rgbaToHexOpacity(fillColorRaw);
    const levels = Array.isArray(selectedDrawing.style?.levels)
      ? (selectedDrawing.style.levels as number[]).filter((v) => Number.isFinite(v)).join(",")
      : "0,0.25,0.5,0.75,1";

    setEditorColor(color);
    setEditorLineWidth(Math.min(8, Math.max(1, Number.isFinite(width) ? width : 2)));
    setEditorLineStyle(lineStyle);
    setEditorRectFillColor(fill.hex);
    setEditorRectFillOpacity(fill.opacity);
    setEditorFiboLevels(levels);
  }, [selectedDrawing]);

  useEffect(() => {
    if (!selectedDrawing || !selectedDrawingAnchor || tool !== "none") {
      setDrawingToolbarPos(null);
      return;
    }

    const place = () => {
      const base = manualToolbarPos ?? selectedDrawingAnchor;
      const clamped = clampToolbarPos(base.x, base.y);
      if (!clamped) {
        return;
      }

      setDrawingToolbarPos((prev) => {
        if (prev && Math.abs(prev.x - clamped.x) < 1 && Math.abs(prev.y - clamped.y) < 1) {
          return prev;
        }
        return clamped;
      });
    };

    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [selectedDrawing, selectedDrawingAnchor, tool, manualToolbarPos]);

  useEffect(() => {
    if (!autoFollow || !replayRunning || currentReplayIndex === null) {
      return;
    }
    centerReplayViewport(currentReplayIndex);
  }, [autoFollow, replayRunning, currentReplayIndex]);

  const drawOverlay = () => {
    const canvas = canvasRef.current;
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;

    if (!canvas || !chart || !candleSeries) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const ratio = window.devicePixelRatio;
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (showMondayLevels) {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);

      for (const w of mondayRanges) {
        const xStart = timeMsToX(w.weekStartMs);
        const xEnd = timeMsToX(w.weekEndMs);
        const yHigh = candleSeries.priceToCoordinate(w.mondayHigh);
        const yLow = candleSeries.priceToCoordinate(w.mondayLow);

        if (xStart === null || xEnd === null || yHigh === null || yLow === null) {
          continue;
        }

        const left = Math.min(xStart, xEnd);
        const right = Math.max(xStart, xEnd);

        ctx.strokeStyle = "rgba(34, 197, 94, 0.95)";
        ctx.beginPath();
        ctx.moveTo(left, yHigh);
        ctx.lineTo(right, yHigh);
        ctx.stroke();

        ctx.strokeStyle = "rgba(239, 68, 68, 0.95)";
        ctx.beginPath();
        ctx.moveTo(left, yLow);
        ctx.lineTo(right, yLow);
        ctx.stroke();
      }

      ctx.restore();
    }

    const drawOne = (
      d: { id?: number; type: "hline" | "rect" | "fibo" | "pricerange" | "longpos" | "shortpos"; points: DrawingPoint[]; style?: Record<string, unknown> },
      preview = false
    ) => {
      const color = String(d.style?.color ?? (preview ? "#fde047" : "#60a5fa"));
      const strokeWidth = Number(d.style?.lineWidth ?? (preview ? 1.5 : 2));
      const isDashed = String(d.style?.lineStyle ?? "solid") === "dashed";
      const isSelected = !preview && d.id === selectedDrawingIdRef.current;

      ctx.strokeStyle = isSelected ? "#facc15" : color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.min(8, Math.max(1, strokeWidth + (isSelected ? 1 : 0)));
      ctx.setLineDash(isDashed ? [8, 4] : []);

      if (d.type === "hline") {
        const p = d.points[0];
        const y = candleSeries.priceToCoordinate(p.price);
        if (y === null) {
          return;
        }
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        return;
      }

      if (d.type === "longpos" || d.type === "shortpos") {
        if (d.points.length < 4) {
          return;
        }

        const entry = d.points[0];
        const sl = d.points[1];
        const tp = d.points[2];
        const end = d.points[3];

        const xStart = timeMsToX(entry.time);
        const xEnd = timeMsToX(end.time);
        const yEntry = candleSeries.priceToCoordinate(entry.price);
        const ySl = candleSeries.priceToCoordinate(sl.price);
        const yTp = candleSeries.priceToCoordinate(tp.price);

        if (xStart === null || xEnd === null || yEntry === null || ySl === null || yTp === null) {
          return;
        }

        const left = Math.min(xStart, xEnd);
        const right = Math.max(xStart, xEnd);
        const rewardTop = Math.min(yEntry, yTp);
        const rewardBottom = Math.max(yEntry, yTp);
        const riskTop = Math.min(yEntry, ySl);
        const riskBottom = Math.max(yEntry, ySl);
        const top = Math.min(yEntry, yTp, ySl);

        ctx.fillStyle = "rgba(34, 197, 94, 0.28)";
        ctx.fillRect(left, rewardTop, Math.abs(right - left), Math.abs(rewardBottom - rewardTop));
        ctx.fillStyle = "rgba(239, 68, 68, 0.28)";
        ctx.fillRect(left, riskTop, Math.abs(right - left), Math.abs(riskBottom - riskTop));

        ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(left, yTp);
        ctx.lineTo(right, yTp);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(left, yEntry);
        ctx.lineTo(right, yEntry);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(left, ySl);
        ctx.lineTo(right, ySl);
        ctx.stroke();

        const risk = Math.abs(entry.price - sl.price);
        const reward = Math.abs(tp.price - entry.price);
        const rr = risk > 0 ? reward / risk : 0;
        const pct = entry.price !== 0 ? (reward / Math.abs(entry.price)) * 100 : 0;
        const label = `${pct.toFixed(2)}% | R:R ${rr.toFixed(2)}`;

        if (!preview) {
          ctx.font = "600 12px sans-serif";
          const textW = ctx.measureText(label).width;
          const labelW = textW + 16;
          const labelH = 28;
          const labelX = Math.max(left + 4, right - labelW - 6);
          const labelY = Math.max(6, top - labelH - 6);
          ctx.fillStyle = "rgba(33, 133, 224, 0.98)";
          ctx.beginPath();
          ctx.roundRect(labelX, labelY, labelW, labelH, 8);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.fillText(label, labelX + 8, labelY + 18);
        }

        if (d.id === selectedDrawingIdRef.current) {
          const r = 6;
          ctx.fillStyle = "#1d4ed8";
          ctx.beginPath();
          ctx.arc(right, yTp, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(right, ySl, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(right, yEntry, r, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }

      if (d.points.length < 2) {
        return;
      }

      const [p1, p2] = d.points;
      const x1 = timeMsToX(p1.time);
      const y1 = candleSeries.priceToCoordinate(p1.price);
      const x2 = timeMsToX(p2.time);
      const y2 = candleSeries.priceToCoordinate(p2.price);

      if (x1 === null || y1 === null || x2 === null || y2 === null) {
        return;
      }

      if (d.type === "rect") {
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const rectWidth = Math.abs(x2 - x1);
        const rectHeight = Math.abs(y2 - y1);

        const fill = String(d.style?.fillColor ?? "rgba(96, 165, 250, 0.2)");
        ctx.fillStyle = fill;
        ctx.globalAlpha = preview ? 0.45 : 1;
        ctx.fillRect(left, top, rectWidth, rectHeight);
        ctx.globalAlpha = 1;
        ctx.strokeRect(left, top, rectWidth, rectHeight);

        return;
      }

      if (d.type === "pricerange") {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);
        const rectWidth = Math.abs(x2 - x1);
        const rectHeight = Math.abs(y2 - y1);

        // TradingView-like semi-transparent range area.
        ctx.fillStyle = "rgba(185, 197, 209, 0.5)";
        ctx.fillRect(left, top, rectWidth, rectHeight);

        // Strong horizontal boundaries.
        ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
        ctx.lineWidth = 2.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(left, top);
        ctx.lineTo(right, top);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(left, bottom);
        ctx.lineTo(right, bottom);
        ctx.stroke();

        // Mid guide line.
        const midX = (left + right) / 2;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(midX, top);
        ctx.lineTo(midX, bottom);
        ctx.stroke();

        if (!preview) {
          const priceDiff = p2.price - p1.price;
          const base = p1.price === 0 ? 1 : p1.price;
          const pct = (priceDiff / base) * 100;
          const label = `${priceDiff >= 0 ? "+" : ""}${priceDiff.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;

          const labelPadX = 10;
          const labelH = 30;
          ctx.font = "600 12px sans-serif";
          const textW = ctx.measureText(label).width;
          const labelW = textW + labelPadX * 2;
          const labelX = Math.min(Math.max(left, midX - labelW / 2), Math.max(left, right - labelW));
          const labelY = Math.max(6, top - labelH - 8);

          ctx.fillStyle = "rgba(33, 133, 224, 0.98)";
          ctx.beginPath();
          ctx.roundRect(labelX, labelY, labelW, labelH, 8);
          ctx.fill();

          ctx.fillStyle = "#ffffff";
          ctx.fillText(label, labelX + labelPadX, labelY + 19);
        }
        return;
      }

      if (d.type === "fibo") {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const topPrice = Math.max(p1.price, p2.price);
        const bottomPrice = Math.min(p1.price, p2.price);

        const levels = Array.isArray(d.style?.levels)
          ? (d.style?.levels as number[]).filter((v) => Number.isFinite(v))
          : FIB_LEVELS;

        levels.forEach((level) => {
          const price = bottomPrice + (topPrice - bottomPrice) * level;
          const y = candleSeries.priceToCoordinate(price);
          if (y === null) {
            return;
          }
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          ctx.fillText(level.toFixed(2), right + 6, y + 4);
        });
      }
    };

    const liveDrawings = drawingsRef.current;
    const livePendingPoint = pendingPointRef.current;
    const liveHoverPoint = hoverPointRef.current;
    const liveTool = toolRef.current;

    let nextSelectedAnchor: { x: number; y: number } | null = null;
    liveDrawings.forEach((d) => {
      drawOne(d);
      if (d.id !== selectedDrawingIdRef.current) {
        return;
      }

      if (d.type === "hline") {
        const y = candleSeries.priceToCoordinate(d.points[0]?.price ?? 0);
        if (y !== null) {
          nextSelectedAnchor = { x: width - 34, y: Math.max(8, y - 26) };
        }
        return;
      }

      if (d.type === "longpos" || d.type === "shortpos") {
        if (d.points.length < 4) {
          return;
        }
        const xEnd = timeMsToX(d.points[3].time);
        const yTp = candleSeries.priceToCoordinate(d.points[2].price);
        if (xEnd !== null && yTp !== null) {
          nextSelectedAnchor = { x: Math.min(width - 34, xEnd + 8), y: Math.max(8, yTp - 26) };
        }
        return;
      }

      if (d.points.length < 2) {
        return;
      }
      const x1 = timeMsToX(d.points[0].time);
      const y1 = candleSeries.priceToCoordinate(d.points[0].price);
      const x2 = timeMsToX(d.points[1].time);
      const y2 = candleSeries.priceToCoordinate(d.points[1].price);
      if (x1 === null || y1 === null || x2 === null || y2 === null) {
        return;
      }
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      nextSelectedAnchor = { x: Math.min(width - 34, right + 8), y: Math.max(8, top - 26) };
    });

    if (livePendingPoint && liveHoverPoint && (liveTool === "rect" || liveTool === "fibo" || liveTool === "pricerange")) {
      drawOne({ type: liveTool, points: [livePendingPoint, liveHoverPoint], style: { color: "#fde047" } }, true);
    }

    const guide = guideRef.current;
    if (guide.visible) {
      ctx.save();
      ctx.strokeStyle = "rgba(190, 210, 255, 0.65)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(guide.x, 0);
      ctx.lineTo(guide.x, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, guide.y);
      ctx.lineTo(width, guide.y);
      ctx.stroke();
      ctx.restore();
    }

    setSelectedDrawingAnchor((prev) => {
      if (!nextSelectedAnchor && !prev) {
        return prev;
      }
      if (!nextSelectedAnchor && prev) {
        return null;
      }
      if (!prev && nextSelectedAnchor) {
        return nextSelectedAnchor;
      }
      if (!prev || !nextSelectedAnchor) {
        return prev;
      }
      const same = Math.abs(prev.x - nextSelectedAnchor.x) < 1 && Math.abs(prev.y - nextSelectedAnchor.y) < 1;
      return same ? prev : nextSelectedAnchor;
    });
  };

  drawOverlayRef.current = drawOverlay;

  const logicalToTimeMs = (logical: number): number | null => {
    if (!Number.isFinite(logical)) {
      return null;
    }

    const rounded = Math.round(logical);
    const stepMs = INTERVAL_MS[interval];

    if (candles.length > 0 && rounded >= 0 && rounded < candles.length) {
      return candles[rounded].openTime;
    }

    if (displayedCandles.length === 0) {
      return null;
    }

    const first = displayedCandles[0].openTime;
    const lastDisplayed = displayedCandles[displayedCandles.length - 1].openTime;

    if (rounded < 0) {
      return first + rounded * stepMs;
    }

    const lastVisibleIndex = displayedCandles.length - 1;
    return lastDisplayed + (rounded - lastVisibleIndex) * stepMs;
  };

  const timeMsToLogical = (timeMs: number): number | null => {
    if (candles.length === 0 || !Number.isFinite(timeMs)) {
      return null;
    }

    const stepMs = INTERVAL_MS[interval];
    const firstTime = candles[0].openTime;
    const lastTime = candles[candles.length - 1].openTime;

    if (timeMs <= firstTime) {
      return (timeMs - firstTime) / stepMs;
    }

    if (timeMs >= lastTime) {
      return candles.length - 1 + (timeMs - lastTime) / stepMs;
    }

    const idx = nearestCandleIndex(candles, timeMs);
    return idx >= 0 ? idx : null;
  };

  const timeMsToX = (timeMs: number): number | null => {
    const chart = chartRef.current;
    if (!chart) {
      return null;
    }

    const direct = chart.timeScale().timeToCoordinate(toUtcTimestamp(timeMs));
    if (direct !== null) {
      return direct;
    }

    const logical = timeMsToLogical(timeMs);
    if (logical === null) {
      return null;
    }

    return chart.timeScale().logicalToCoordinate(logical as Logical);
  };

  const getPointFromCoordinates = (x: number, y: number): DrawingPoint | null => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries) {
      return null;
    }

    const price = candleSeries.coordinateToPrice(y);
    const time = chart.timeScale().coordinateToTime(x);

    let ms = timeToMs(time);
    if (ms === null) {
      const logical = chart.timeScale().coordinateToLogical(x);
      if (logical !== null) {
        ms = logicalToTimeMs(logical);
      }
    }
    if (price === null || ms === null) {
      return null;
    }
    return { time: ms, price };
  };

  const hitTestDrawing = (x: number, y: number): Drawing | null => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) {
      return null;
    }

    const tol = 7;
    const items = drawingsRef.current;

    for (let i = items.length - 1; i >= 0; i -= 1) {
      const d = items[i];

      if (d.type === "hline") {
        const yLine = candleSeries.priceToCoordinate(d.points[0]?.price ?? 0);
        if (yLine !== null && Math.abs(y - yLine) <= tol) {
          return d;
        }
        continue;
      }

      if (d.type === "longpos" || d.type === "shortpos") {
        if (d.points.length < 4) {
          continue;
        }
        const xStart = timeMsToX(d.points[0].time);
        const xEnd = timeMsToX(d.points[3].time);
        const yTp = candleSeries.priceToCoordinate(d.points[2].price);
        const ySl = candleSeries.priceToCoordinate(d.points[1].price);
        const yEntry = candleSeries.priceToCoordinate(d.points[0].price);
        if (xStart === null || xEnd === null || yTp === null || ySl === null || yEntry === null) {
          continue;
        }
        const left = Math.min(xStart, xEnd);
        const right = Math.max(xStart, xEnd);
        const top = Math.min(yTp, ySl, yEntry);
        const bottom = Math.max(yTp, ySl, yEntry);
        const inside = x >= left - tol && x <= right + tol && y >= top - tol && y <= bottom + tol;
        if (inside) {
          return d;
        }
        continue;
      }

      if (d.points.length < 2) {
        continue;
      }

      const x1 = timeMsToX(d.points[0].time);
      const y1 = candleSeries.priceToCoordinate(d.points[0].price);
      const x2 = timeMsToX(d.points[1].time);
      const y2 = candleSeries.priceToCoordinate(d.points[1].price);

      if (x1 === null || y1 === null || x2 === null || y2 === null) {
        continue;
      }

      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);

      if (d.type === "rect" || d.type === "pricerange") {
        const inside = x >= left - tol && x <= right + tol && y >= top - tol && y <= bottom + tol;
        if (inside) {
          return d;
        }
        continue;
      }

      const levels = Array.isArray(d.style?.levels)
        ? (d.style.levels as number[]).filter((v) => Number.isFinite(v))
        : FIB_LEVELS;
      for (const level of levels) {
        const price = Math.min(d.points[0].price, d.points[1].price) + Math.abs(d.points[0].price - d.points[1].price) * level;
        const yLevel = candleSeries.priceToCoordinate(price);
        if (yLevel === null) {
          continue;
        }
        const xInRange = x >= left - tol && x <= right + tol;
        if (xInRange && Math.abs(y - yLevel) <= tol) {
          return d;
        }
      }
    }

    return null;
  };

  hitTestDrawingRef.current = hitTestDrawing;

  const hitTestPositionHandle = (x: number, y: number): PositionHandle | null => {
    const selected = selectedDrawingRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!selected || !candleSeries) {
      return null;
    }
    if (!(selected.type === "longpos" || selected.type === "shortpos") || selected.points.length < 4) {
      return null;
    }

    const xEnd = timeMsToX(selected.points[3].time);
    const yTp = candleSeries.priceToCoordinate(selected.points[2].price);
    const ySl = candleSeries.priceToCoordinate(selected.points[1].price);
    const yEntry = candleSeries.priceToCoordinate(selected.points[0].price);
    if (xEnd === null || yTp === null || ySl === null || yEntry === null) {
      return null;
    }

    const tol = 10;
    if (Math.abs(x - xEnd) <= tol && Math.abs(y - yTp) <= tol) {
      return "tp";
    }
    if (Math.abs(x - xEnd) <= tol && Math.abs(y - ySl) <= tol) {
      return "sl";
    }
    if (Math.abs(x - xEnd) <= tol && Math.abs(y - yEntry) <= tol) {
      return "time";
    }
    return null;
  };

  hitTestPositionHandleRef.current = hitTestPositionHandle;

  const getPointFromEvent = (e: React.MouseEvent<HTMLCanvasElement>): DrawingPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    return getPointFromCoordinates(x, y);
  };

  const saveDrawing = async (payload: { type: "hline" | "rect" | "fibo" | "pricerange" | "longpos" | "shortpos"; points: DrawingPoint[] }) => {
    const style: Record<string, unknown> = {
      color: "#60a5fa",
      lineWidth: 2,
      lineStyle: "solid",
    };

    if (payload.type === "rect") {
      style.fillColor = hexToRgba("#60a5fa", 0.2);
    }

    if (payload.type === "fibo") {
      style.levels = [0, 0.25, 0.5, 0.75, 1];
    }

    if (payload.type === "pricerange") {
      style.mode = "tv";
    }

    if (payload.type === "longpos" || payload.type === "shortpos") {
      style.mode = "position";
    }

    const res = await api.post<Drawing>("/api/drawings", {
      symbol: SYMBOL,
      type: payload.type,
      points: payload.points,
      style,
    });

    setDrawings((prev) => [...prev, res.data]);
    setSelectedDrawingId(res.data.id);
  };

  const onCanvasClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (tool === "none" && canvas) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = hitTestDrawingRef.current(x, y);
      setSelectedDrawingId(hit?.id ?? null);
      return;
    }

    const point = getPointFromEvent(e);
    if (!point) {
      return;
    }

    if (tool === "replay-start") {
      const idx = nearestCandleIndex(candles, point.time);
      if (idx >= 0) {
        setReplayStartIndex(idx);
        setCurrentReplayIndex(null);
        setReplayRunning(false);
        centerReplayViewport(idx);
      }
      return;
    }

    if (tool === "hline") {
      await saveDrawing({ type: "hline", points: [point] });
      setTool("none");
      return;
    }

    if (tool === "longpos" || tool === "shortpos") {
      const stepMs = INTERVAL_MS[interval];
      const defaultRisk = point.price * 0.01;
      const endTime = point.time + stepMs * 40;
      const slPrice = tool === "longpos" ? point.price - defaultRisk : point.price + defaultRisk;
      const tpPrice = tool === "longpos" ? point.price + defaultRisk : point.price - defaultRisk;

      await saveDrawing({
        type: tool,
        points: [
          { time: point.time, price: point.price },
          { time: point.time, price: slPrice },
          { time: point.time, price: tpPrice },
          { time: endTime, price: point.price },
        ],
      });
      setTool("none");
      return;
    }

    if (tool === "rect" || tool === "fibo" || tool === "pricerange") {
      if (!pendingPoint) {
        setPendingPoint(point);
        return;
      }

      await saveDrawing({ type: tool, points: [pendingPoint, point] });
      setPendingPoint(null);
      setHoverPoint(null);
      setTool("none");
    }
  };

  const onCanvasMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      guideRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        visible: true,
      };
    }

    if (draggingHandle && selectedDrawingRef.current && (selectedDrawingRef.current.type === "longpos" || selectedDrawingRef.current.type === "shortpos")) {
      const dragPoint = getPointFromEvent(e);
      if (!dragPoint) {
        return;
      }

      const selected = selectedDrawingRef.current;
      const nextPoints = [...selected.points];
      if (nextPoints.length < 4) {
        return;
      }

      if (draggingHandle === "tp") {
        nextPoints[2] = { ...nextPoints[2], price: dragPoint.price };
      } else if (draggingHandle === "sl") {
        nextPoints[1] = { ...nextPoints[1], price: dragPoint.price };
      } else if (draggingHandle === "time") {
        const minTime = nextPoints[0].time + INTERVAL_MS[interval];
        nextPoints[3] = { ...nextPoints[3], time: Math.max(minTime, dragPoint.time) };
      }

      setDrawings((prev) => prev.map((d) => (d.id === selected.id ? { ...d, points: nextPoints } : d)));
      return;
    }

    if (!pendingPoint || !(tool === "rect" || tool === "fibo" || tool === "pricerange")) {
      drawOverlayRef.current();
      return;
    }
    const point = getPointFromEvent(e);
    if (point) {
      setHoverPoint((prev) => {
        if (!prev) {
          return point;
        }
        const sameTime = Math.abs(prev.time - point.time) < 250;
        const samePrice = Math.abs(prev.price - point.price) < 0.25;
        return sameTime && samePrice ? prev : point;
      });
    }
    drawOverlayRef.current();
  };

  const onCanvasLeave = () => {
    guideRef.current = { x: 0, y: 0, visible: false };
    drawOverlayRef.current();
  };

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!(selectedDrawing?.type === "longpos" || selectedDrawing?.type === "shortpos") || tool !== "none") {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const handle = hitTestPositionHandleRef.current(x, y);
    if (handle) {
      setDraggingHandle(handle);
    }
  };

  const onCanvasMouseUp = async () => {
    if (!draggingHandle) {
      return;
    }
    const selectedId = selectedDrawingIdRef.current;
    const selected = selectedId === null ? null : drawingsRef.current.find((d) => d.id === selectedId) ?? null;
    setDraggingHandle(null);
    if (!selected) {
      return;
    }
    await api.put(`/api/drawings/${selected.id}`, { points: selected.points });
  };

  const onToolbarDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawingToolbarPos) {
      return;
    }
    e.preventDefault();
    toolbarDragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: drawingToolbarPos.x,
      originY: drawingToolbarPos.y,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = toolbarDragRef.current;
      if (!drag.active) {
        return;
      }
      const nextX = drag.originX + (e.clientX - drag.startX);
      const nextY = drag.originY + (e.clientY - drag.startY);
      const clamped = clampToolbarPos(nextX, nextY);
      if (!clamped) {
        return;
      }
      setManualToolbarPos(clamped);
      setDrawingToolbarPos(clamped);
    };

    const onUp = () => {
      if (!toolbarDragRef.current.active) {
        return;
      }
      toolbarDragRef.current.active = false;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onSync = async () => {
    setSyncing(true);
    try {
      await api.post("/api/sync", { symbol: SYMBOL, interval });
      const twoYearsAgo = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
      const candlesRes = await api.get<Candle[]>("/api/candles", {
        params: { symbol: SYMBOL, interval, from: twoYearsAgo, to: Date.now() },
      });
      setCandles(candlesRes.data);
    } finally {
      setSyncing(false);
    }
  };

  const onStartReplay = () => {
    if (replayStartIndex === null) {
      return;
    }

    if (currentReplayIndex === null) {
      setCurrentReplayIndex(replayStartIndex);
    }
    setReplayRunning(true);
  };

  const onPauseReplay = () => {
    setReplayRunning(false);
    setTool("none");
    setPendingPoint(null);
    setHoverPoint(null);
  };

  const onToggleReplay = () => {
    if (!isReplayPrepared) {
      return;
    }
    if (replayRunning) {
      onPauseReplay();
      return;
    }
    onStartReplay();
  };

  const onResetReplay = () => {
    setReplayRunning(false);
    setCurrentReplayIndex(null);
    setReplayStartIndex(null);
    setSelectedDrawingId(null);
  };

  const onApplyEma = () => {
    const periods = parsePeriods(emaInput);
    setEmaPeriods(periods);
    localStorage.setItem("emaPeriods", periods.join(","));
  };

  const updateSelectedDrawingStyle = async (patch: Record<string, unknown>) => {
    const selected = selectedDrawingRef.current;
    if (!selected) {
      return;
    }

    const nextStyle = { ...(selected.style ?? {}), ...patch };
    setDrawings((prev) => prev.map((d) => (d.id === selected.id ? { ...d, style: nextStyle } : d)));
    await api.put(`/api/drawings/${selected.id}`, { style: nextStyle });
  };

  const onEditorColorChange = (value: string) => {
    setEditorColor(value);
    void updateSelectedDrawingStyle({ color: value });
  };

  const onEditorWidthChange = (value: number) => {
    const next = Math.min(8, Math.max(1, value || 1));
    setEditorLineWidth(next);
    void updateSelectedDrawingStyle({ lineWidth: next });
  };

  const onEditorLineStyleChange = (value: LineStyleOption) => {
    setEditorLineStyle(value);
    void updateSelectedDrawingStyle({ lineStyle: value });
  };

  const onEditorRectFillColorChange = (value: string) => {
    setEditorRectFillColor(value);
    const rgba = hexToRgba(value, editorRectFillOpacity);
    void updateSelectedDrawingStyle({ fillColor: rgba });
  };

  const onEditorRectOpacityChange = (value: number) => {
    const next = Math.min(1, Math.max(0, value));
    setEditorRectFillOpacity(next);
    const rgba = hexToRgba(editorRectFillColor, next);
    void updateSelectedDrawingStyle({ fillColor: rgba });
  };

  const onEditorFiboLevelsChange = (value: string) => {
    setEditorFiboLevels(value);
    void updateSelectedDrawingStyle({ levels: parseFiboLevels(value) });
  };

  const onDeleteDrawing = async (id: number) => {
    await api.delete(`/api/drawings/${id}`);
    setDrawings((prev) => prev.filter((d) => d.id !== id));
    setSelectedDrawingId((prev) => (prev === id ? null : prev));
  };

  const onDeleteSelectedDrawing = async () => {
    if (selectedDrawingId === null) {
      return;
    }
    await onDeleteDrawing(selectedDrawingId);
    setSelectedDrawingAnchor(null);
  };

  const dimRightStyle = useMemo(() => {
    const chart = chartRef.current;
    if (!chart || replayStartTimeMs === null || isReplayInProgress) {
      return { display: "none" } as const;
    }

    const x = chart.timeScale().timeToCoordinate(toUtcTimestamp(replayStartTimeMs));
    if (x === null) {
      return { display: "none" } as const;
    }

    return {
      display: "block",
      left: `${Math.max(0, x)}px`,
    } as const;
  }, [replayStartTimeMs, isReplayInProgress, displayedCandles.length]);

  return (
    <div className="page">
      <div className="topbar">
        <h1>Crypto Replay</h1>
        <div className="muted">Symbol: {SYMBOL} Spot</div>
      </div>

      <div className="controls-row">
        <label>
          Interval
          <select value={interval} onChange={(e) => setInterval(e.target.value as Interval)}>
            {INTERVALS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>

        <button onClick={onSync} disabled={syncing}>
          {syncing ? "Syncing..." : "Sync Missing Data"}
        </button>

        <label>
          EMA periods
          <input value={emaInput} onChange={(e) => setEmaInput(e.target.value)} placeholder="20,50,200" />
        </label>
        <button onClick={onApplyEma}>Apply EMA</button>
      </div>

      <div className="controls-row">
        <button className={tool === "replay-start" ? "active" : ""} onClick={() => setTool("replay-start")}>
          Set Replay Start
        </button>
        <label>
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
        <button onClick={onToggleReplay} disabled={!isReplayPrepared}>
          {replayRunning ? "Pause" : isReplayInProgress ? "Resume" : "Start"}
        </button>
        <button className={autoFollow ? "active" : ""} onClick={() => setAutoFollow((prev) => !prev)}>
          Auto-follow: {autoFollow ? "On" : "Off"}
        </button>
        <button className={showMondayLevels ? "active" : ""} onClick={() => setShowMondayLevels((prev) => !prev)}>
          Monday High/Low: {showMondayLevels ? "On" : "Off"}
        </button>
        <button onClick={onResetReplay} disabled={!isReplayPrepared && !isReplayInProgress}>
          Reset
        </button>
      </div>

      <div className="controls-row">
        <button className={tool === "none" ? "active" : ""} onClick={() => setTool("none")}>
          Cursor
        </button>
        <button className={tool === "hline" ? "active" : ""} onClick={() => setTool("hline")}>
          Horizontal Line
        </button>
        <button className={tool === "rect" ? "active" : ""} onClick={() => setTool("rect")}>
          Rectangle
        </button>
        <button className={tool === "fibo" ? "active" : ""} onClick={() => setTool("fibo")}>
          Fibonacci
        </button>
        <button className={tool === "pricerange" ? "active" : ""} onClick={() => setTool("pricerange")}>
          Price Range
        </button>
        <button className={tool === "longpos" ? "active" : ""} onClick={() => setTool("longpos")}>
          Long Position
        </button>
        <button className={tool === "shortpos" ? "active" : ""} onClick={() => setTool("shortpos")}>
          Short Position
        </button>
        {pendingPoint && (tool === "rect" || tool === "fibo" || tool === "pricerange") && (
          <button onClick={() => setPendingPoint(null)}>Cancel Pending Draw</button>
        )}
      </div>

      <div className="status-row">
        {loading ? "Loading candles..." : `Candles loaded: ${candles.length}`}
        {isReplayPrepared && replayStartIndex !== null && (
          <span>
            Replay start: {new Date(candles[replayStartIndex].openTime).toLocaleString()}
          </span>
        )}
        {isReplayInProgress && currentReplayIndex !== null && (
          <span>
            Replay candle: {currentReplayIndex + 1} / {candles.length}
          </span>
        )}
      </div>

      <div className="chart-wrap" ref={chartWrapRef}>
        <div className="chart-container" ref={chartContainerRef} />
        <canvas
          ref={canvasRef}
          className="overlay-canvas"
          style={{ pointerEvents: isCanvasInteractive ? "auto" : "none" }}
          onClick={(e) => void onCanvasClick(e)}
          onMouseDown={onCanvasMouseDown}
          onMouseUp={() => void onCanvasMouseUp()}
          onMouseMove={onCanvasMove}
          onMouseLeave={onCanvasLeave}
        />
        <div className="dim-right" style={dimRightStyle} />
        {selectedDrawing && drawingToolbarPos && tool === "none" && (
          <div
            ref={drawingToolbarRef}
            className="drawing-toolbar"
            style={{ left: `${drawingToolbarPos.x}px`, top: `${drawingToolbarPos.y}px` }}
          >
            <div className="toolbar-drag-handle" onMouseDown={onToolbarDragStart} title="Drag toolbar">
              ⋮⋮
            </div>
            {selectedDrawing.type !== "pricerange" && selectedDrawing.type !== "longpos" && selectedDrawing.type !== "shortpos" && (
              <>
                <label>
                  Color
                  <input type="color" value={editorColor} onChange={(e) => onEditorColorChange(e.target.value)} />
                </label>
                <label>
                  Width
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={editorLineWidth}
                    onChange={(e) => onEditorWidthChange(Number(e.target.value))}
                  />
                </label>
                <label>
                  Style
                  <select value={editorLineStyle} onChange={(e) => onEditorLineStyleChange(e.target.value as LineStyleOption)}>
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                  </select>
                </label>
              </>
            )}
            {selectedDrawing.type === "rect" && (
              <>
                <label>
                  Fill
                  <input type="color" value={editorRectFillColor} onChange={(e) => onEditorRectFillColorChange(e.target.value)} />
                </label>
                <label>
                  Opacity
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={editorRectFillOpacity}
                    onChange={(e) => onEditorRectOpacityChange(Number(e.target.value))}
                  />
                </label>
              </>
            )}
            {selectedDrawing.type === "fibo" && (
              <label>
                Levels
                <input value={editorFiboLevels} onChange={(e) => onEditorFiboLevelsChange(e.target.value)} placeholder="0,0.25,0.5,0.75,1" />
              </label>
            )}
            {selectedDrawing.type === "pricerange" && <span className="toolbar-note">Price Range style: TradingView-like preset</span>}
            {(selectedDrawing.type === "longpos" || selectedDrawing.type === "shortpos") && (
              <span className="toolbar-note">Drag blue handles on chart to change TP, SL and time</span>
            )}
            <button className="delete-drawing-btn" onClick={() => void onDeleteSelectedDrawing()} title="Delete selected drawing">
              🗑
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
