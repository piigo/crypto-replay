import axios from "axios";
import { Candle, Interval } from "./types.js";

const BASE_URL = process.env.BINANCE_BASE_URL ?? "https://api.binance.com";

const intervalMap: Record<Interval, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1D": "1d",
  "1W": "1w",
  "1M": "1M",
};

export const intervalMsMap: Record<Interval, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

export async function fetchKlines(params: {
  symbol: string;
  interval: Interval;
  startTime: number;
  endTime: number;
  limit?: number;
}): Promise<Candle[]> {
  const { symbol, interval, startTime, endTime, limit = 1000 } = params;

  const response = await axios.get(`${BASE_URL}/api/v3/klines`, {
    params: {
      symbol,
      interval: intervalMap[interval],
      startTime,
      endTime,
      limit,
    },
    timeout: 20000,
  });

  return (response.data as unknown[]).map((item) => {
    const row = item as [number, string, string, string, string, string, number];
    return {
      symbol,
      interval,
      openTime: row[0],
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: row[6],
    };
  });
}
