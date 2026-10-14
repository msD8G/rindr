// Settings for coi-serviceworker.js (loaded right after this file): messages only with ?debug.
// A file instead of an inline script – the Content-Security-Policy allows no inline scripts.
window.coi = { quiet: !new URLSearchParams(location.search).has('debug') };
