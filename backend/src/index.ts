import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { pool } from "./lib/db.js";
import { fetchKlines, intervalMsMap } from "./binance.js";
import { Interval } from "./types.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3001);

const intervalSchema = z.enum(["5m", "15m", "1h", "4h", "1D", "1W", "1M"]);

const syncSchema = z.object({
  symbol: z.string().default("BTCUSDT"),
  interval: intervalSchema,
});

const drawingsSchema = z.object({
  symbol: z.string().default("BTCUSDT"),
  type: z.enum(["hline", "rect", "fibo", "pricerange", "longpos", "shortpos"]),
  points: z.array(z.object({ time: z.number(), price: z.number() })).min(1),
  style: z.record(z.unknown()).default({}),
});

app.get("/api/health", async (_req, res) => {
  const dbOk = await pool.query("SELECT 1");
  res.json({ ok: true, db: dbOk.rowCount === 1 });
});

app.get("/api/candles", async (req, res) => {
  const symbol = (req.query.symbol as string) || "BTCUSDT";
  const intervalResult = intervalSchema.safeParse(req.query.interval);

  if (!intervalResult.success) {
    res.status(400).json({ error: "Invalid interval" });
    return;
  }

  const interval = intervalResult.data;

  const from = Number(req.query.from ?? 0);
  const to = Number(req.query.to ?? Date.now());

  const rows = await pool.query<{
    symbol: string;
    interval: string;
    open_time: string;
    close_time: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>(
    `
      SELECT symbol, interval, open_time, close_time, open, high, low, close, volume
      FROM candles
      WHERE symbol = $1
      AND interval = $2
      AND open_time >= $3
      AND open_time <= $4
      ORDER BY open_time ASC
    `,
    [symbol, interval, from, to]
  );

  res.json(
    rows.rows.map((r) => ({
      symbol: r.symbol,
      interval: r.interval,
      openTime: Number(r.open_time),
      closeTime: Number(r.close_time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }))
  );
});

app.post("/api/sync", async (req, res) => {
  const parsed = syncSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { symbol, interval } = parsed.data;

  const lastRow = await pool.query(
    `
      SELECT MAX(open_time) AS max_open_time
      FROM candles
      WHERE symbol = $1 AND interval = $2
    `,
    [symbol, interval]
  );

  const maxOpenTime = Number(lastRow.rows[0]?.max_open_time ?? 0);
  const now = Date.now();
  const twoYearsAgo = now - 2 * 365 * 24 * 60 * 60 * 1000;
  const stepMs = intervalMsMap[interval as Interval];

  // Re-fetch one previous candle to avoid edge gaps between sync runs.
  let cursor = maxOpenTime > 0 ? Math.max(twoYearsAgo, maxOpenTime - stepMs) : twoYearsAgo;
  let inserted = 0;

  while (cursor < now) {
    const batch = await fetchKlines({
      symbol,
      interval: interval as Interval,
      startTime: cursor,
      endTime: now,
      limit: 1000,
    });

    if (batch.length === 0) {
      break;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      for (const c of batch) {
        await client.query(
          `
            INSERT INTO candles (symbol, interval, open_time, close_time, open, high, low, close, volume)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (symbol, interval, open_time) DO NOTHING
          `,
          [c.symbol, c.interval, c.openTime, c.closeTime, c.open, c.high, c.low, c.close, c.volume]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    inserted += batch.length;

    const last = batch[batch.length - 1];
    cursor = last.openTime + stepMs;

    if (batch.length < 1000) {
      break;
    }
  }

  res.json({ ok: true, inserted, symbol, interval });
});

app.get("/api/drawings", async (req, res) => {
  const symbol = (req.query.symbol as string) || "BTCUSDT";

  const rows = await pool.query(
    `
      SELECT id, symbol, type, points, style, created_at, updated_at
      FROM drawings
      WHERE symbol = $1
      ORDER BY created_at ASC
    `,
    [symbol]
  );

  res.json(rows.rows);
});

app.post("/api/drawings", async (req, res) => {
  const parsed = drawingsSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { symbol, type, points, style } = parsed.data;

  const row = await pool.query(
    `
      INSERT INTO drawings(symbol, type, points, style)
      VALUES ($1, $2, $3::jsonb, $4::jsonb)
      RETURNING id, symbol, type, points, style, created_at, updated_at
    `,
    [symbol, type, JSON.stringify(points), JSON.stringify(style)]
  );

  res.status(201).json(row.rows[0]);
});

app.put("/api/drawings/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid drawing id" });
    return;
  }

  const parsed = drawingsSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const fields = parsed.data;
  const sets: string[] = [];
  const values: unknown[] = [];

  if (fields.type) {
    values.push(fields.type);
    sets.push(`type = $${values.length}`);
  }

  if (fields.points) {
    values.push(JSON.stringify(fields.points));
    sets.push(`points = $${values.length}::jsonb`);
  }

  if (fields.style) {
    values.push(JSON.stringify(fields.style));
    sets.push(`style = $${values.length}::jsonb`);
  }

  if (fields.symbol) {
    values.push(fields.symbol);
    sets.push(`symbol = $${values.length}`);
  }

  if (sets.length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  values.push(id);

  const row = await pool.query(
    `
      UPDATE drawings
      SET ${sets.join(", ")}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING id, symbol, type, points, style, created_at, updated_at
    `,
    values
  );

  if (row.rowCount === 0) {
    res.status(404).json({ error: "Drawing not found" });
    return;
  }

  res.json(row.rows[0]);
});

app.delete("/api/drawings/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid drawing id" });
    return;
  }

  const deleted = await pool.query("DELETE FROM drawings WHERE id = $1", [id]);
  if (deleted.rowCount === 0) {
    res.status(404).json({ error: "Drawing not found" });
    return;
  }

  res.status(204).send();
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
