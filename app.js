// =========================================================================
// 1. LOCAL BROWSER CACHE (IndexedDB for 20Y data + localStorage for settings)
// =========================================================================
const DB_NAME = "hobbes-finance-cache";
const STORE_NAME = "tickers";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const PREFS_KEY = "hobbes-finance-prefs-v1";

function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readLocalCache(key) {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeLocalCache(key, data) {
  try {
    const db = await openCacheDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ updatedAt: Date.now(), data }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore storage errors (e.g., private browsing restrictions)
  }
}

// =========================================================================
// 2. APP STATE & SAVED PREFERENCES
// =========================================================================
const DEFAULT_PREFS = {
  ticker: "RY.TO",
  compareTicker: "TSX",
  timeframe: "5Y",
  chartType: "line",     // "line" | "candle"
  scaleType: "linear",   // "linear" | "log"
  compareOn: false,
  volumeOn: true,
  indicatorMode: "raw",  // "raw" | "percentile"
  ma: { period: 200, overlay: true, sub: true },
  rsi: { period: 14, sub: true },
  macd: { fast: 12, slow: 26, sub: false }
};

function loadSavedPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return structuredClone(DEFAULT_PREFS);
    const saved = JSON.parse(raw);
    return {
      ...DEFAULT_PREFS,
      ...saved,
      ma: { ...DEFAULT_PREFS.ma, ...(saved.ma || {}) },
      rsi: { ...DEFAULT_PREFS.rsi, ...(saved.rsi || {}) },
      macd: { ...DEFAULT_PREFS.macd, ...(saved.macd || {}) }
    };
  } catch {
    return structuredClone(DEFAULT_PREFS);
  }
}

const savedPrefs = loadSavedPrefs();

const state = {
  mainData: null,
  compareData: null,
  ...savedPrefs
};

function savePrefs() {
  try {
    const toSave = {
      ticker: state.ticker,
      compareTicker: state.compareTicker,
      timeframe: state.timeframe,
      chartType: state.chartType,
      scaleType: state.scaleType,
      compareOn: state.compareOn,
      volumeOn: state.volumeOn,
      indicatorMode: state.indicatorMode,
      ma: state.ma,
      rsi: state.rsi,
      macd: state.macd
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(toSave));
  } catch {
    // Ignore storage errors
  }
}

function syncUIWithState() {
  document.getElementById("ticker-input").value = state.ticker;
  document.getElementById("compare-input").value = state.compareTicker;
  document.getElementById("compare-toggle").checked = state.compareOn;
  document.getElementById("volume-toggle").checked = state.volumeOn;

  document.querySelectorAll(".tf-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tf === state.timeframe);
  });

  document.getElementById("type-line").classList.toggle("active", state.chartType === "line");
  document.getElementById("type-candle").classList.toggle("active", state.chartType === "candle");

  document.getElementById("scale-linear").classList.toggle("active", state.scaleType === "linear");
  document.getElementById("scale-log").classList.toggle("active", state.scaleType === "log");

  document.getElementById("ma-period").value = state.ma.period;
  document.getElementById("ma-overlay-toggle").checked = state.ma.overlay;
  document.getElementById("ma-sub-toggle").checked = state.ma.sub;

  document.getElementById("rsi-period").value = state.rsi.period;
  document.getElementById("rsi-sub-toggle").checked = state.rsi.sub;

  document.getElementById("macd-fast").value = state.macd.fast;
  document.getElementById("macd-slow").value = state.macd.slow;
  document.getElementById("macd-sub-toggle").checked = state.macd.sub;

  document.getElementById("mode-raw").classList.toggle("active", state.indicatorMode === "raw");
  document.getElementById("mode-percentile").classList.toggle("active", state.indicatorMode === "percentile");
}

const COLORS = {
  blue: "#1d4ed8",
  red: "#dc2626",
  green: "#15803d",
  brown: "#92400e",
  grid: "#e2e8f0",
  text: "#334155",
  volUp: "rgba(21, 128, 61, 0.35)",
  volDown: "rgba(220, 38, 38, 0.35)"
};

// =========================================================================
// 3. DATA FETCHING + LOCAL CACHING
// =========================================================================
const memoryCache = new Map();

function sanitizeKey(symbol) {
  return symbol.trim().toUpperCase().replace(/[^A-Z0-9._^-]/g, "_");
}

async function fetchTickerData(rawSymbol) {
  const key = sanitizeKey(rawSymbol);
  if (memoryCache.has(key)) {
    return { data: memoryCache.get(key), source: "memory" };
  }

  const cached = await readLocalCache(key);
  if (cached && cached.data && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    memoryCache.set(key, cached.data);
    return { data: cached.data, source: "local" };
  }

  const res = await fetch(`/.netlify/functions/stock?symbol=${encodeURIComponent(rawSymbol)}`);
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(json.error || `Failed to load ${rawSymbol}`);
  }

  memoryCache.set(key, json);
  memoryCache.set(sanitizeKey(json.symbol), json);
  await writeLocalCache(key, json);

  return { data: json, source: "live" };
}

// =========================================================================
// 4. TECHNICAL INDICATOR MATH & PERCENTILE FORMATTING
// =========================================================================
function computeSMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function computeEMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function computeRSI(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1 || values.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function toPercentiles(series) {
  const valid = series.filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  const n = valid.length;
  if (n < 2) return series.map(() => null);

  return series.map((v) => {
    if (v == null || !isFinite(v)) return null;
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (valid[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    const lower = lo;
    hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (valid[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    const avgRank = (lower + (lo - 1)) / 2;
    return Math.round((avgRank / (n - 1)) * 100);
  });
}

function formatOrdinal(num) {
  const n = Math.round(num);
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

function getPercentileLabel(num) {
  const n = Math.round(num);
  if (n <= 2)  return { text: "Black Swan Event", cls: "verdict-black-swan" };
  if (n <= 10) return { text: "Extremely Low",    cls: "verdict-ext-low" };
  if (n <= 25) return { text: "Low",              cls: "verdict-low" };
  if (n <= 40) return { text: "Below Average",    cls: "verdict-mid" };
  if (n <= 59) return { text: "Average",          cls: "verdict-mid" };
  if (n <= 74) return { text: "Above Average",    cls: "verdict-mid" };
  if (n <= 89) return { text: "High",             cls: "verdict-high" };
  if (n <= 97) return { text: "Extremely High",   cls: "verdict-ext-high" };
  return              { text: "Historic Extreme", cls: "verdict-historic" };
}

function renderPercentileReadout(elId, val) {
  const el = document.getElementById(elId);
  if (val == null || !isFinite(val)) {
    el.innerHTML = "";
    return;
  }
  const { text, cls } = getPercentileLabel(val);
  el.innerHTML = `<span class="pct-verdict ${cls}">${text}</span><span class="pct-num">(${formatOrdinal(val)} percentile)</span>`;
}

function addPercentileGuideLines(series) {
  series.createPriceLine({
    price: 100,
    color: "#000000",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Solid,
    axisLabelVisible: false
  });
  series.createPriceLine({
    price: 50,
    color: "#94a3b8",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: false
  });
  series.createPriceLine({
    price: 0,
    color: "#000000",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Solid,
    axisLabelVisible: false
  });
}

function getTimeframeStartDate(latestDateStr, tf) {
  const d = new Date(latestDateStr + "T00:00:00Z");
  if (tf === "3M") d.setUTCMonth(d.getUTCMonth() - 3);
  else if (tf === "6M") d.setUTCMonth(d.getUTCMonth() - 6);
  else if (tf === "12M") d.setUTCFullYear(d.getUTCFullYear() - 1);
  else if (tf === "2Y") d.setUTCFullYear(d.getUTCFullYear() - 2);
  else if (tf === "5Y") d.setUTCFullYear(d.getUTCFullYear() - 5);
  else if (tf === "10Y") d.setUTCFullYear(d.getUTCFullYear() - 10);
  else d.setUTCFullYear(d.getUTCFullYear() - 20);
  return d.toISOString().slice(0, 10);
}

// =========================================================================
// 5. CHART INSTANCES & SYNCHRONIZATION
// =========================================================================
let charts = { main: null, ma: null, rsi: null, macd: null };
let isSyncing = false;

function createBaseChart(container, height, extraRightScale = {}) {
  return LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height,
    layout: {
      background: { type: "solid", color: "#ffffff" },
      textColor: COLORS.text,
      fontSize: 12
    },
    grid: {
      vertLines: { color: COLORS.grid },
      horzLines: { color: COLORS.grid }
    },
    rightPriceScale: {
      borderColor: "#cbd5e1",
      minimumWidth: 72,
      ...extraRightScale
    },
    timeScale: {
      borderColor: "#cbd5e1",
      timeVisible: false
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    }
  });
}

function destroyAllCharts() {
  Object.keys(charts).forEach((k) => {
    if (charts[k]) {
      charts[k].remove();
      charts[k] = null;
    }
  });
}

function syncChartTimeScales(activeCharts) {
  activeCharts.forEach((source) => {
    source.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (isSyncing || !range) return;
      isSyncing = true;
      activeCharts.forEach((target) => {
        if (target !== source) {
          target.timeScale().setVisibleLogicalRange(range);
        }
      });
      isSyncing = false;
    });
  });
}

const PCT_AUTOSCALE = () => ({
  priceRange: { minValue: 0, maxValue: 100 }
});

const PCT_PRICE_FORMAT = {
  type: "price",
  precision: 0,
  minMove: 1
};

// =========================================================================
// 6. RENDER EVERYTHING
// =========================================================================
function renderAll() {
  if (!state.mainData || !state.mainData.bars.length) return;

  destroyAllCharts();

  const fullBars = state.mainData.bars;
  const fullCloses = fullBars.map((b) => b.close);
  const fullLogCloses = fullBars.map((b) => Math.log(b.close));
  const isPct = state.indicatorMode === "percentile";

  // --- Compute all indicators on FULL 20Y data first ---
  // 1. MA Overlay (raw price) & MA Distance Sub-chart
  const maPeriod = Math.max(2, Number(state.ma.period) || 200);
  const maRawPrice = computeSMA(fullCloses, maPeriod);
  const maDistPct = fullCloses.map((c, i) =>
    maRawPrice[i] != null ? ((c - maRawPrice[i]) / maRawPrice[i]) * 100 : null
  );
  const maLogSma = computeSMA(fullLogCloses, maPeriod);
  const maLogDist = fullLogCloses.map((lc, i) =>
    maLogSma[i] != null ? lc - maLogSma[i] : null
  );
  const maDistPercentiles = toPercentiles(maLogDist);

  // 2. RSI
  const rsiPeriod = Math.max(2, Number(state.rsi.period) || 14);
  const rsiRaw = computeRSI(fullCloses, rsiPeriod);
  const rsiLog = computeRSI(fullLogCloses, rsiPeriod);
  const rsiPercentiles = toPercentiles(rsiLog);

  // 3. MACD
  const macdFast = Math.max(2, Number(state.macd.fast) || 12);
  const macdSlow = Math.max(macdFast + 1, Number(state.macd.slow) || 26);
  const emaFastRaw = computeEMA(fullCloses, macdFast);
  const emaSlowRaw = computeEMA(fullCloses, macdSlow);
  const macdRawLine = fullCloses.map((_, i) =>
    emaFastRaw[i] != null && emaSlowRaw[i] != null ? emaFastRaw[i] - emaSlowRaw[i] : null
  );
  const macdSignalRaw = new Array(fullCloses.length).fill(null);
  const validMacdIdx = macdRawLine.findIndex((v) => v != null);
  if (validMacdIdx !== -1) {
    const sliced = macdRawLine.slice(validMacdIdx);
    const sig = computeEMA(sliced, 9);
    sig.forEach((val, idx) => { macdSignalRaw[validMacdIdx + idx] = val; });
  }
  const macdHistRaw = macdRawLine.map((v, i) =>
    v != null && macdSignalRaw[i] != null ? v - macdSignalRaw[i] : null
  );

  const emaFastLog = computeEMA(fullLogCloses, macdFast);
  const emaSlowLog = computeEMA(fullLogCloses, macdSlow);
  const macdLogLine = fullLogCloses.map((_, i) =>
    emaFastLog[i] != null && emaSlowLog[i] != null ? emaFastLog[i] - emaSlowLog[i] : null
  );
  const macdPercentiles = toPercentiles(macdLogLine);

  // --- Slice to Active Timeframe ---
  const latestDate = fullBars[fullBars.length - 1].time;
  const startDate = getTimeframeStartDate(latestDate, state.timeframe);
  let startIdx = fullBars.findIndex((b) => b.time >= startDate);
  if (startIdx < 0) startIdx = 0;

  const visBars = fullBars.slice(startIdx);
  const sliceSeries = (arr) =>
    visBars
      .map((b, i) => ({ time: b.time, value: arr[startIdx + i] }))
      .filter((p) => p.value != null && isFinite(p.value));

  // --- Update Top Banner ---
  const firstClose = visBars[0].close;
  const lastClose = visBars[visBars.length - 1].close;
  const pctChange = ((lastClose - firstClose) / firstClose) * 100;

  document.getElementById("display-symbol").textContent = state.mainData.symbol;
  document.getElementById("display-name").textContent = state.mainData.name;
  document.getElementById("display-exchange").textContent =
    `${state.mainData.exchange} · ${state.mainData.currency}`.replace(/^ · /, "");
  document.getElementById("display-price").textContent = lastClose.toFixed(2);
  const changeEl = document.getElementById("display-change");
  changeEl.textContent = `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(2)}% (${state.timeframe})`;
  changeEl.className = `price-change ${pctChange >= 0 ? "up" : "down"}`;

  // --- Main Chart ---
  const mainContainer = document.getElementById("main-chart");
  charts.main = createBaseChart(mainContainer, 480, {
    mode: state.scaleType === "log"
      ? LightweightCharts.PriceScaleMode.Logarithmic
      : LightweightCharts.PriceScaleMode.Normal
  });

  const legendItems = [];
  if (state.chartType === "candle") {
    const candleSeries = charts.main.addCandlestickSeries({
      upColor: COLORS.green,
      downColor: COLORS.red,
      borderUpColor: COLORS.green,
      borderDownColor: COLORS.red,
      wickUpColor: COLORS.green,
      wickDownColor: COLORS.red
    });
    candleSeries.setData(visBars);
    legendItems.push({ color: COLORS.green, label: `${state.mainData.symbol} (Candles)` });
  } else {
    const lineSeries = charts.main.addLineSeries({
      color: COLORS.blue,
      lineWidth: 2.5
    });
    lineSeries.setData(visBars.map((b) => ({ time: b.time, value: b.close })));
    legendItems.push({ color: COLORS.blue, label: `${state.mainData.symbol} (Close)` });
  }

  // MA Overlay on Main Chart
  if (state.ma.overlay) {
    const maSeries = charts.main.addLineSeries({
      color: COLORS.red,
      lineWidth: 2,
      priceLineVisible: false
    });
    maSeries.setData(sliceSeries(maRawPrice));
    legendItems.push({ color: COLORS.red, label: `${maPeriod}D MA` });
  }

  // Normalized Comparison Overlay (anchored to left edge of active timeframe)
  if (state.compareOn && state.compareData?.bars?.length) {
    const compMap = new Map(state.compareData.bars.map((b) => [b.time, b.close]));
    let baseComp = null;
    for (let i = state.compareData.bars.length - 1; i >= 0; i--) {
      if (state.compareData.bars[i].time <= visBars[0].time) {
        baseComp = state.compareData.bars[i].close;
        break;
      }
    }
    if (baseComp == null) baseComp = state.compareData.bars[0].close;

    const anchorPrice = visBars[0].close;
    let lastKnownComp = baseComp;
    const normData = visBars.map((b) => {
      if (compMap.has(b.time)) lastKnownComp = compMap.get(b.time);
      return {
        time: b.time,
        value: Number(((lastKnownComp / baseComp) * anchorPrice).toFixed(4))
      };
    });

    const compSeries = charts.main.addLineSeries({
      color: COLORS.brown,
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false
    });
    compSeries.setData(normData);
    legendItems.push({
      color: COLORS.brown,
      label: `${state.compareData.symbol} (Normalized to ${visBars[0].time})`
    });
  }

  // Volume at base of Main Chart (no right-axis tag overlap)
  if (state.volumeOn) {
    const volSeries = charts.main.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false
    });
    charts.main.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 }
    });
    volSeries.setData(
      visBars.map((b) => ({
        time: b.time,
        value: b.volume,
        color: b.close >= b.open ? COLORS.volUp : COLORS.volDown
      }))
    );
  }

  document.getElementById("main-legend").innerHTML = legendItems
    .map((it) => `<span class="legend-item"><span class="swatch" style="background:${it.color}"></span>${it.label}</span>`)
    .join("");

  charts.main.timeScale().fitContent();
  const activeCharts = [charts.main];

  const pctScaleOpts = isPct ? { scaleMargins: { top: 0.06, bottom: 0.06 } } : {};

  // --- Sub-Chart 1: MA Distance ---
  const maWrap = document.getElementById("ma-sub-wrap");
  if (state.ma.sub) {
    maWrap.classList.remove("hidden");
    const data = sliceSeries(isPct ? maDistPercentiles : maDistPct);
    const lastVal = data.length ? data[data.length - 1].value : null;

    document.getElementById("ma-sub-title").textContent = isPct
      ? `Distance from ${maPeriod}D MA — Percentile`
      : `Distance from ${maPeriod}D MA — Raw (%)`;

    if (isPct) {
      renderPercentileReadout("ma-sub-readout", lastVal);
    } else {
      document.getElementById("ma-sub-readout").textContent =
        lastVal != null ? `${lastVal >= 0 ? "+" : ""}${lastVal.toFixed(2)}%` : "";
    }

    charts.ma = createBaseChart(document.getElementById("ma-chart"), 155, pctScaleOpts);
    const s = charts.ma.addLineSeries({
      color: COLORS.blue,
      lineWidth: 2,
      priceFormat: isPct ? PCT_PRICE_FORMAT : undefined,
      autoscaleInfoProvider: isPct ? PCT_AUTOSCALE : undefined
    });
    s.setData(data);

    if (isPct) {
      addPercentileGuideLines(s);
    } else {
      s.createPriceLine({ price: 0, color: "#475569", lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
    }
    charts.ma.timeScale().fitContent();
    activeCharts.push(charts.ma);
  } else {
    maWrap.classList.add("hidden");
  }

  // --- Sub-Chart 2: RSI ---
  const rsiWrap = document.getElementById("rsi-sub-wrap");
  if (state.rsi.sub) {
    rsiWrap.classList.remove("hidden");
    const data = sliceSeries(isPct ? rsiPercentiles : rsiRaw);
    const lastVal = data.length ? data[data.length - 1].value : null;

    document.getElementById("rsi-sub-title").textContent = isPct
      ? `RSI (${rsiPeriod}) — Percentile`
      : `RSI (${rsiPeriod}) — Raw`;

    if (isPct) {
      renderPercentileReadout("rsi-sub-readout", lastVal);
    } else {
      document.getElementById("rsi-sub-readout").textContent =
        lastVal != null ? lastVal.toFixed(1) : "";
    }

    charts.rsi = createBaseChart(document.getElementById("rsi-chart"), 155, pctScaleOpts);
    const s = charts.rsi.addLineSeries({
      color: COLORS.green,
      lineWidth: 2,
      priceFormat: isPct ? PCT_PRICE_FORMAT : undefined,
      autoscaleInfoProvider: isPct ? PCT_AUTOSCALE : undefined
    });
    s.setData(data);

    if (isPct) {
      addPercentileGuideLines(s);
    } else {
      s.createPriceLine({ price: 70, color: COLORS.red, lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
      s.createPriceLine({ price: 50, color: "#64748b", lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      s.createPriceLine({ price: 30, color: COLORS.green, lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
    }

    charts.rsi.timeScale().fitContent();
    activeCharts.push(charts.rsi);
  } else {
    rsiWrap.classList.add("hidden");
  }

  // --- Sub-Chart 3: MACD ---
  const macdWrap = document.getElementById("macd-sub-wrap");
  if (state.macd.sub) {
    macdWrap.classList.remove("hidden");

    document.getElementById("macd-sub-title").textContent = isPct
      ? `MACD (${macdFast}, ${macdSlow}) — Percentile`
      : `MACD (${macdFast}, ${macdSlow}, 9) — Raw`;

    charts.macd = createBaseChart(document.getElementById("macd-chart"), 155, pctScaleOpts);

    if (isPct) {
      const data = sliceSeries(macdPercentiles);
      const lastVal = data.length ? data[data.length - 1].value : null;
      renderPercentileReadout("macd-sub-readout", lastVal);

      const s = charts.macd.addLineSeries({
        color: COLORS.brown,
        lineWidth: 2,
        priceFormat: PCT_PRICE_FORMAT,
        autoscaleInfoProvider: PCT_AUTOSCALE
      });
      s.setData(data);
      addPercentileGuideLines(s);
    } else {
      const histData = sliceSeries(macdHistRaw).map((p) => ({
        time: p.time,
        value: p.value,
        color: p.value >= 0 ? "rgba(21, 128, 61, 0.45)" : "rgba(220, 38, 38, 0.45)"
      }));
      const histSeries = charts.macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      histSeries.setData(histData);

      const lineData = sliceSeries(macdRawLine);
      const sigData = sliceSeries(macdSignalRaw);
      const macdLineSeries = charts.macd.addLineSeries({ color: COLORS.blue, lineWidth: 2, priceLineVisible: false });
      const sigLineSeries = charts.macd.addLineSeries({ color: COLORS.red, lineWidth: 1.5, priceLineVisible: false });
      macdLineSeries.setData(lineData);
      sigLineSeries.setData(sigData);

      const lastVal = lineData.length ? lineData[lineData.length - 1].value : null;
      document.getElementById("macd-sub-readout").textContent =
        lastVal != null ? lastVal.toFixed(2) : "";
    }

    charts.macd.timeScale().fitContent();
    activeCharts.push(charts.macd);
  } else {
    macdWrap.classList.add("hidden");
  }

  syncChartTimeScales(activeCharts);
}

// =========================================================================
// 7. LOADING HANDLERS & UI WIRING
// =========================================================================
function setStatus(msg, isError = false) {
  const el = document.getElementById("status-bar");
  el.textContent = msg;
  el.className = isError ? "status-bar error" : "status-bar";
}

async function loadMainTicker(symbol) {
  const cleaned = symbol.trim().toUpperCase();
  if (!cleaned) return;
  setStatus(`Loading ${cleaned}...`);
  try {
    const { data, source } = await fetchTickerData(cleaned);
    state.mainData = data;
    state.ticker = cleaned;
    savePrefs();
    const badge = document.getElementById("cache-badge");
    badge.style.display = "inline-block";
    badge.textContent = source === "local" ? "Local Cache" : source === "memory" ? "Cached" : "Live Yahoo";
    setStatus(`Loaded ${data.bars.length.toLocaleString()} daily bars for ${data.symbol}.`);
    renderAll();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function loadCompareTicker(symbol) {
  const cleaned = symbol.trim().toUpperCase();
  if (!cleaned) return;
  setStatus(`Loading comparison ${cleaned}...`);
  try {
    const { data } = await fetchTickerData(cleaned);
    state.compareData = data;
    state.compareTicker = cleaned;
    savePrefs();
    setStatus(`Comparison set to ${data.symbol}.`);
    renderAll();
  } catch (err) {
    setStatus(err.message, true);
  }
}

// Top Controls
document.getElementById("load-btn").addEventListener("click", () => {
  loadMainTicker(document.getElementById("ticker-input").value);
});

document.getElementById("ticker-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadMainTicker(e.target.value);
});

document.getElementById("timeframe-buttons").addEventListener("click", (e) => {
  const btn = e.target.closest(".tf-btn");
  if (!btn) return;
  document.querySelectorAll(".tf-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.timeframe = btn.dataset.tf;
  savePrefs();
  renderAll();
});

document.getElementById("type-line").addEventListener("click", () => {
  state.chartType = "line";
  document.getElementById("type-line").classList.add("active");
  document.getElementById("type-candle").classList.remove("active");
  savePrefs();
  renderAll();
});

document.getElementById("type-candle").addEventListener("click", () => {
  state.chartType = "candle";
  document.getElementById("type-candle").classList.add("active");
  document.getElementById("type-line").classList.remove("active");
  savePrefs();
  renderAll();
});

document.getElementById("scale-linear").addEventListener("click", () => {
  state.scaleType = "linear";
  document.getElementById("scale-linear").classList.add("active");
  document.getElementById("scale-log").classList.remove("active");
  savePrefs();
  renderAll();
});

document.getElementById("scale-log").addEventListener("click", () => {
  state.scaleType = "log";
  document.getElementById("scale-log").classList.add("active");
  document.getElementById("scale-linear").classList.remove("active");
  savePrefs();
  renderAll();
});

document.getElementById("compare-toggle").addEventListener("change", async (e) => {
  state.compareOn = e.target.checked;
  savePrefs();
  if (state.compareOn && !state.compareData) {
    await loadCompareTicker(document.getElementById("compare-input").value);
  } else {
    renderAll();
  }
});

document.getElementById("compare-load-btn").addEventListener("click", async () => {
  document.getElementById("compare-toggle").checked = true;
  state.compareOn = true;
  savePrefs();
  await loadCompareTicker(document.getElementById("compare-input").value);
});

document.getElementById("compare-input").addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    document.getElementById("compare-toggle").checked = true;
    state.compareOn = true;
    savePrefs();
    await loadCompareTicker(e.target.value);
  }
});

document.getElementById("compare-shortcuts").addEventListener("click", async (e) => {
  const chip = e.target.closest(".shortcut-chip");
  if (!chip) return;
  const sym = chip.dataset.sym;
  document.getElementById("compare-input").value = sym;
  document.getElementById("compare-toggle").checked = true;
  state.compareOn = true;
  savePrefs();
  await loadCompareTicker(sym);
});

document.getElementById("volume-toggle").addEventListener("change", (e) => {
  state.volumeOn = e.target.checked;
  savePrefs();
  renderAll();
});

// Indicator Controls
document.getElementById("ma-period").addEventListener("change", (e) => {
  state.ma.period = Number(e.target.value) || 200;
  savePrefs();
  renderAll();
});
document.getElementById("ma-overlay-toggle").addEventListener("change", (e) => {
  state.ma.overlay = e.target.checked;
  savePrefs();
  renderAll();
});
document.getElementById("ma-sub-toggle").addEventListener("change", (e) => {
  state.ma.sub = e.target.checked;
  savePrefs();
  renderAll();
});

document.getElementById("rsi-period").addEventListener("change", (e) => {
  state.rsi.period = Number(e.target.value) || 14;
  savePrefs();
  renderAll();
});
document.getElementById("rsi-sub-toggle").addEventListener("change", (e) => {
  state.rsi.sub = e.target.checked;
  savePrefs();
  renderAll();
});

document.getElementById("macd-fast").addEventListener("change", (e) => {
  state.macd.fast = Number(e.target.value) || 12;
  savePrefs();
  renderAll();
});
document.getElementById("macd-slow").addEventListener("change", (e) => {
  state.macd.slow = Number(e.target.value) || 26;
  savePrefs();
  renderAll();
});
document.getElementById("macd-sub-toggle").addEventListener("change", (e) => {
  state.macd.sub = e.target.checked;
  savePrefs();
  renderAll();
});

// Global Raw vs Percentiles toggle
document.getElementById("mode-raw").addEventListener("click", () => {
  state.indicatorMode = "raw";
  document.getElementById("mode-raw").classList.add("active");
  document.getElementById("mode-percentile").classList.remove("active");
  savePrefs();
  renderAll();
});

document.getElementById("mode-percentile").addEventListener("click", () => {
  state.indicatorMode = "percentile";
  document.getElementById("mode-percentile").classList.add("active");
  document.getElementById("mode-raw").classList.remove("active");
  savePrefs();
  renderAll();
});

// Responsive resize
window.addEventListener("resize", () => {
  const resize = (chart, id) => {
    if (!chart) return;
    const el = document.getElementById(id);
    if (el && el.clientWidth > 0) chart.applyOptions({ width: el.clientWidth });
  };
  resize(charts.main, "main-chart");
  resize(charts.ma, "ma-chart");
  resize(charts.rsi, "rsi-chart");
  resize(charts.macd, "macd-chart");
});

// Initial load using saved settings
async function init() {
  syncUIWithState();
  await loadMainTicker(state.ticker);
  if (state.compareOn && state.compareTicker) {
    await loadCompareTicker(state.compareTicker);
  }
}

init();
