# Crypto Replay (Local MVP)

Local Docker app with TradingView-style bar replay for BTCUSDT Spot.

## Stack
- Backend: Node.js + TypeScript + Express
- Frontend: React + TypeScript + lightweight-charts
- Database: PostgreSQL

## Features
- Candlestick chart with time axis (date/time on bottom)
- Replay mode:
  - Set replay vertical line on chart
  - Right side dim before start
  - Start/Resume/Pause/Reset
  - Bar-by-bar playback with speed selector (1x, 2x, 5x, 10x)
- Drawings persisted in PostgreSQL (global by symbol):
  - Horizontal line
  - Rectangle
  - Fibonacci levels (0, 0.25, 0.5, 0.75, 1)
- EMA with configurable periods (multiple values, e.g. `20,50,200`)
- Intervals: `5m, 15m, 1h, 4h, 1D, 1W, 1M`
- Manual "Sync Missing Data" from Binance Spot into PostgreSQL (2 years supported)

## Run
```bash
docker compose up --build
```

Open:
- Frontend: http://localhost:5173
- Backend health: http://localhost:3001/api/health

## First use
1. Choose interval.
2. Click `Sync Missing Data`.
3. Set replay point with `Set Replay Start`, click chart.
4. Click `Start`.
5. Pause replay and use drawing tools.

## Notes
- Current scope: single symbol `BTCUSDT`, no auth, local usage only.
- Drawings are shared globally for `BTCUSDT` and remain after restart.
