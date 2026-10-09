// Response cache in IndexedDB (falls back to memory if IndexedDB is unavailable).
const DB_NAME = "nurse-commute";
const STORE = "responses";
const mem = new Map();
let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch(() => null);
  }
  return dbPromise;
}

export async function cacheGet(key, ttlMs) {
  let v = mem.get(key);
  if (!v) {
    const d = await db();
    if (d) {
      try { v = await req(d.transaction(STORE).objectStore(STORE).get(key)); } catch (e) { v = undefined; }
    }
  }
  if (v && Date.now() - v.t < ttlMs) {
    mem.set(key, v);
    return v.data;
  }
  return undefined;
}

export async function cachePut(key, data) {
  const v = { t: Date.now(), data };
  mem.set(key, v);
  const d = await db();
  if (d) {
    try { await req(d.transaction(STORE, "readwrite").objectStore(STORE).put(v, key)); } catch (e) { /* quota etc. */ }
  }
}

export async function cacheClear() {
  mem.clear();
  const d = await db();
  if (d) await req(d.transaction(STORE, "readwrite").objectStore(STORE).clear());
}
