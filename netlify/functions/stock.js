const ALIASES = {
  "S&P": "^GSPC",
  "SP500": "^GSPC",
  "S&P500": "^GSPC",
  "SPX": "^GSPC",
  "TSX": "^GSPTSE",
  "S&P/TSX": "^GSPTSE",
  "WTI": "CL=F",
  "WTI CRUDE": "CL=F",
  "CRUDE": "CL=F",
  "OIL": "CL=F",
  "NASDAQ": "^IXIC",
  "DOW": "^DJI",
  "GOLD": "GC=F",
  "CAD": "CAD=X",
  "USDCAD": "CAD=X"
};

exports.handler = async (event) => {
  const rawInput = (event.queryStringParameters?.symbol || "").trim().toUpperCase();
  if (!rawInput) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing ticker symbol." })
    };
  }

  const symbol = ALIASES[rawInput] || rawInput;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=20y&interval=1d&events=div,splits`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=20y&interval=1d&events=div,splits`
  ];

  let payload = null;
  let lastError = "Unable to reach Yahoo Finance.";

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status} for ${symbol}`;
        continue;
      }
      const json = await res.json();
      if (json.chart?.result?.[0]) {
        payload = json.chart.result[0];
        break;
      }
      if (json.chart?.error?.description) {
        lastError = json.chart.error.description;
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  if (!payload) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `Could not load "${rawInput}" (${symbol}): ${lastError}` })
    };
  }

  const meta = payload.meta || {};
  const timestamps = payload.timestamp || [];
  const quote = payload.indicators?.quote?.[0] || {};
  const adjcloseArr = payload.indicators?.adjclose?.[0]?.adjclose || [];

  // Deduplicate by YYYY-MM-DD and adjust OHLC for splits/dividends
  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close?.[i];
    if (close == null || !isFinite(close) || close <= 0) continue;

    const adj = adjcloseArr[i];
    const ratio = (adj != null && isFinite(adj) && adj > 0) ? adj / close : 1;

    const openRaw = quote.open?.[i] ?? close;
    const highRaw = quote.high?.[i] ?? close;
    const lowRaw = quote.low?.[i] ?? close;
    const vol = quote.volume?.[i] ?? 0;

    const dateStr = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    byDate.set(dateStr, {
      time: dateStr,
      open: Number((openRaw * ratio).toFixed(4)),
      high: Number((highRaw * ratio).toFixed(4)),
      low: Number((lowRaw * ratio).toFixed(4)),
      close: Number((close * ratio).toFixed(4)),
      volume: Math.round(vol)
    });
  }

  const bars = Array.from(byDate.values()).sort((a, b) => a.time.localeCompare(b.time));

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300"
    },
    body: JSON.stringify({
      symbol: meta.symbol || symbol,
      name: meta.longName || meta.shortName || symbol,
      currency: meta.currency || "USD",
      exchange: meta.exchangeName || "",
      bars
    })
  };
};