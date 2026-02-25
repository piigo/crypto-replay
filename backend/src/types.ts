export type Interval = "5m" | "15m" | "1h" | "4h" | "1D" | "1W" | "1M";

export type Candle = {
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

export type DrawingType = "hline" | "rect" | "fibo" | "pricerange" | "longpos" | "shortpos";

export type DrawingPoint = {
  time: number;
  price: number;
};

export type Drawing = {
  id: number;
  symbol: string;
  type: DrawingType;
  points: DrawingPoint[];
  style: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
