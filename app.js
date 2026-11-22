// =========================================================================
// 1. LOCAL BROWSER CACHE (IndexedDB — persists across refreshes/restarts)
// =========================================================================
const DB_NAME = "hobbes-finance-cache";
const STORE_NAME = "tickers";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

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
// 2. APP STATE
// =========================================================================
const state = {
  mainData: null,        // { symbol, name, currency, exchange, bars: [...] }
  compareData: null,
  timeframe: "5Y",
  chartType: "line",     // "line" | "candle"
  compareOn: false,
  volumeOn: true,
  ma: { period: 200, overlay: true, sub: true, mode: "raw" },
  rsi: { period: 14, sub: true, mode: "raw" },
  macd: { fast: 12, slow: 26, sub: false, mode: "raw" }
};

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

  // Try Local Browser Cache (IndexedDB) first