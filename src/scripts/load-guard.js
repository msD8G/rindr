// Crash detection for model loads: running out of memory ends the tab without any JS error (Chrome: "Aw, Snap"), so
// the next start has to find out. A marker in sessionStorage (survives the tab's reload, not a new tab) is set while
// a model loads and removed when the load ends or the page is left normally (pagehide – reload, close, navigation).
// Still there at the next start → the tab died while loading. The same file is then opened in safe mode (smaller
// memory budget: coarser tessellation, fewer workers in parallel – memory-budget.js).

const LOADING = 'rindr.loading';
const SAFE = 'rindr.safeLoad';

const read = key => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } };
const write = (key, value) => { try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* storage blocked */ } };

/** A load starts: { name, size, url } of the model */
export const beginLoad = info => write(LOADING, { name: info.name, size: info.size ?? null, url: info.url ?? null, at: Date.now() });
/** The load ended (finished, failed, aborted) */
export const endLoad = () => write(LOADING, null);

// leaving the page normally is no crash
globalThis.addEventListener?.('pagehide', endLoad);

/** At start: the model whose load ended the tab last time (or null); the marker is consumed */
export function crashedLoad() {
    const info = read(LOADING);
    write(LOADING, null);
    return info;
}

/** Open this model sparingly next time */
export const markSafe = info => write(SAFE, { name: info.name, size: info.size ?? null });

/** Should this model be opened in safe mode? (same name, same size if both are known) */
export function isSafe(info) {
    const s = read(SAFE);
    return !!s && s.name === info.name && (s.size == null || info.size == null || s.size === info.size);
}

/** The model opened fine (in safe mode): normal again */
export const clearSafe = () => write(SAFE, null);
