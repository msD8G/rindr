// Info output in the browser console only while debugging (?debug) – the normal page stays quiet.
// Warnings and errors (console.warn/error) are always shown.
export const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

/** console.info only with ?debug (bound: the console shows the caller's line) */
export const debugLog = DEBUG ? console.info.bind(console) : () => {};
