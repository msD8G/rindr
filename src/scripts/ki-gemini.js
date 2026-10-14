// AI rendering without a server: the browser calls Google Gemini directly with the user's own API key.
//
// - Settings (key, model, resolution) in localStorage, per browser. The key is readable by any script on
//   the page (XSS, some extensions) – it is the user's own key on their own machine; the settings say so.
// - Requests + results in IndexedDB (database "rindr-ki", store "renders": input/output as Blob):
//   history and cache – identical requests (model, size, aspect, instruction, prompt, image) are served
//   from it without a new (paid) call. Stays on this machine.
// - Gemini (Interactions API, x-goog-api-key header – Google allows CORS); same request as the former
//   PHP broker (server/ki.php in git history): fixed instruction + prompt + image, response_format
//   image with aspect ratio/size; models that do not know response_format → once again without.
// Errors: KiError with a machine-readable code → ki.errors.<CODE> in the language files.

import { KI } from './config.js';

const STORE_KEY = 'rindr.ki.apiKey';
const STORE_MODEL = 'rindr.ki.model';
const STORE_SIZE = 'rindr.ki.size';

const read = key => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const write = (key, value) => {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* storage blocked */ }
};

export const kiSettings = {
    get apiKey() { return read(STORE_KEY); },
    set apiKey(v) { write(STORE_KEY, (v || '').trim()); },
    get model() { return read(STORE_MODEL) || KI.model; },
    set model(v) { write(STORE_MODEL, (v || '').trim() === KI.model ? '' : (v || '').trim()); },
    get size() { return KI.sizes.includes(read(STORE_SIZE)) ? read(STORE_SIZE) : KI.size; },
    set size(v) { write(STORE_SIZE, v); },
    /** "••••••••abcd" – shown instead of the key */
    get masked() { const k = this.apiKey; return k ? '•'.repeat(8) + k.slice(-4) : ''; },
};

export class KiError extends Error {
    constructor(code, message, params = {}) {
        super(message);
        this.code = code;
        this.params = params;
    }
}

// --- Gemini ---

const ASPECTS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/** Image aspect ratio → nearest one supported by Gemini */
function nearestAspect(w, h) {
    let best = '1:1', bd = Infinity;
    for (const a of ASPECTS) {
        const [x, y] = a.split(':').map(Number);
        const d = Math.abs(Math.log((w / h) / (x / y)));
        if (d < bd) { bd = d; best = a; }
    }
    return best;
}

/** Fixed instruction before the viewer's prompt: composition stays, only photorealism */
const SYSTEM_INSTRUCTION = [
    'You turn a 3D CAD rendering into a photorealistic product photograph.',
    'Keep the exact composition, camera angle, framing, object geometry, proportions, part layout and colours of the input image.',
    'Do not add, remove, move or reshape any parts, holes, edges or text.',
    'Improve only realism: physically plausible materials, surface micro-detail, reflections, lighting, shadows and depth of field.',
    'The materials of the parts are described below; apply them to the matching coloured areas.',
].join(' ');

const b64ToBlob = (data, mime) => {
    const bin = atob(data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
};
const blobToB64 = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
});
const sha256 = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');

async function callGemini({ key, model, prompt, image, aspect, size, signal }) {
    const body = {
        model,
        input: [
            { type: 'text', text: SYSTEM_INSTRUCTION + '\n\n' + prompt },
            { type: 'image', mime_type: image.type, data: await blobToB64(image) },
        ],
        response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: aspect, image_size: size },
    };
    const send = async () => {
        let res;
        try {
            res = await fetch(KI.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify(body),
                signal,
            });
        } catch (err) {
            if (err.name === 'AbortError' || err.name === 'TimeoutError') throw err;
            throw new KiError('PROVIDER_UNREACHABLE', `AI provider unreachable: ${err.message}`, { detail: err.message });
        }
        const raw = await res.text();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        return { status: res.status, json, raw };
    };
    let { status, json, raw } = await send();
    // older/other models may not know response_format for images: retry once without it
    if (status === 400 && raw.includes('response_format')) {
        delete body.response_format;
        ({ status, json, raw } = await send());
    }
    if (status !== 200 || !json) {
        const detail = json?.error?.message || raw.slice(0, 500);
        if (status === 400 && /api key/i.test(detail) || status === 401 || status === 403) throw new KiError('INVALID_API_KEY', `API key rejected: ${detail}`, { detail });
        throw new KiError('PROVIDER_ERROR', `AI provider: HTTP ${status} – ${detail}`, { status, detail });
    }
    // find the image: Interactions (steps[].content[] {type: image, data}, output_image) or
    // generateContent (candidates[].content.parts[].inlineData) – recursive, the last image wins
    let found = null;
    const text = [];
    const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'image' && node.data) found = [node.mime_type || 'image/png', node.data];
        for (const k of ['inlineData', 'inline_data']) if (node[k]?.data) found = [node[k].mimeType || node[k].mime_type || 'image/png', node[k].data];
        if (node.type === 'text' && node.text) text.push(node.text);
        for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
    };
    walk(json.steps || json);
    if (!found && json.output_image?.data) found = [json.output_image.mime_type || 'image/png', json.output_image.data];
    if (!found) {
        const detail = text.join(' ');
        throw new KiError(detail ? 'NO_IMAGE_TEXT' : 'NO_IMAGE', 'AI returned no image' + (detail ? ': ' + detail : ''), { detail });
    }
    let output;
    try { output = b64ToBlob(found[1], found[0]); } catch { throw new KiError('IMAGE_UNREADABLE', 'AI image not readable'); }
    return { output, text: text.length ? text.join('\n') : null, usage: json.usage || null };
}

// --- IndexedDB (history + cache) ---

let dbPromise = null;
function db() {
    dbPromise ??= new Promise((resolve, reject) => {
        const req = indexedDB.open('rindr-ki', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('renders', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(new KiError('STORAGE_ERROR', `IndexedDB: ${req.error?.message}`, { detail: req.error?.message })); };
    });
    return dbPromise;
}
async function tx(mode, run) {
    const store = (await db()).transaction('renders', mode).objectStore('renders');
    return new Promise((resolve, reject) => {
        const req = run(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new KiError('STORAGE_ERROR', `IndexedDB: ${req.error?.message}`, { detail: req.error?.message }));
    });
}

// object URLs of the stored images, one pair per entry (released on delete)
const urls = new Map();
function withUrls(entry) {
    if (!entry) return null;
    let u = urls.get(entry.id);
    if (!u) urls.set(entry.id, u = { input: URL.createObjectURL(entry.input), output: URL.createObjectURL(entry.output) });
    return { ...entry, input_url: u.input, output_url: u.output };
}

/** Previous requests, newest first */
export async function history(limit = 60) {
    const all = await tx('readonly', s => s.getAll());
    return all.sort((a, b) => b.created.localeCompare(a.created)).slice(0, limit).map(withUrls);
}

export async function removeRender(id) {
    await tx('readwrite', s => s.delete(id));
    const u = urls.get(id);
    if (u) { URL.revokeObjectURL(u.input); URL.revokeObjectURL(u.output); urls.delete(id); }
}

/**
 * Image (Blob or data: URL) + prompt → AI image. Same inputs → stored result (unless force).
 * @returns entry { id, created, title, model, size, aspect, prompt, input_url, output_url, duration_ms, model_text, cached }
 */
export async function render({ image, prompt, title = '', size, materials = [], force = false, signal }) {
    const key = kiSettings.apiKey;
    if (!key) throw new KiError('NO_API_KEY', 'No API key (settings → AI rendering)');
    if (!prompt.trim()) throw new KiError('INVALID_PROMPT', 'Prompt missing', { limit: 8000 });
    if (typeof image === 'string') image = await (await fetch(image)).blob();
    if (!/^image\/(png|jpeg|webp)$/.test(image.type)) throw new KiError('INVALID_IMAGE', 'Not a valid image');
    const bitmap = await createImageBitmap(image).catch(() => null);
    if (!bitmap) throw new KiError('INVALID_IMAGE', 'Not a valid image');
    const dim = [bitmap.width, bitmap.height];
    bitmap.close();
    const model = kiSettings.model;
    size = KI.sizes.includes(size) ? size : kiSettings.size;
    const aspect = nearestAspect(dim[0], dim[1]);
    const imageHash = await sha256(await image.arrayBuffer());
    const id = (await sha256(new TextEncoder().encode([model, size, aspect, SYSTEM_INSTRUCTION, prompt, imageHash].join('|')))).slice(0, 16);
    if (!force) {
        const cached = await tx('readonly', s => s.get(id)).catch(() => null);
        if (cached) return { ...withUrls(cached), cached: true };
    }
    const t0 = performance.now();
    const result = await callGemini({ key, model, prompt, image, aspect, size, signal });
    const entry = {
        id, created: new Date().toISOString(), title: title.slice(0, 200), model, size, aspect, prompt,
        system: SYSTEM_INSTRUCTION, materials: materials.slice(0, 200), input: image, output: result.output,
        input_size: dim, duration_ms: Math.round(performance.now() - t0), model_text: result.text, usage: result.usage,
    };
    // regenerated: replace the stored images of this id
    const old = urls.get(id);
    if (old) { URL.revokeObjectURL(old.input); URL.revokeObjectURL(old.output); urls.delete(id); }
    await tx('readwrite', s => s.put(entry));
    return { ...withUrls(entry), cached: false };
}
