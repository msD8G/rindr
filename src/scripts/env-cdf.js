// Importance-sampling table of the environment for the path tracer, computed in a worker.
// three-gpu-pathtracer computes it in EquirectHdrInfoUniform.updateFrom on the main thread (Studio 2048²
// ~140 ms, 4k HDRI several hundred ms) – and per HQ start three times (setScene, useMegakernel twice).
// prepareEnvCdf() computes it in advance in a worker and caches it per texture data; the Vite patch in
// astro.config.mjs (EquirectHdrInfoNode.updateFrom) takes a ready result via applyEnvCdf() instead of
// computing it – without a result the library computes it itself as before.
import { ClampToEdgeWrapping, HalfFloatType, RepeatWrapping, TextureSource } from 'three/webgpu';

// texture data (Uint16Array) -> { signature, promise, result }. Keyed by the data, not by texture/source
// version: the path tracer works on clones (share the data), and clone() bumps the source version.
const cache = new WeakMap();

const supported = tex => Boolean(tex?.isTexture && tex.type === HalfFloatType && !tex.flipY
    && tex.image?.data instanceof Uint16Array && tex.image.width > 0 && tex.image.height > 0);

// sample of the data: notices data changed in place (e.g. a regenerated procedural texture)
function signature({ data, width, height }) {
    let sum = width * 31 + height;
    for (let i = 0, step = Math.max(1, Math.floor(data.length / 4096)); i < data.length; i += step) sum = (sum * 33 + data[i]) | 0;
    return sum;
}

function entryOf(tex) {
    const entry = supported(tex) ? cache.get(tex.image.data) : null;
    return entry && entry.signature === signature(tex.image) ? entry : null;
}

/** Result ready for this texture (or nothing to prepare) – the library will not compute on the main thread */
export function isEnvCdfReady(tex) {
    return !supported(tex) || Boolean(entryOf(tex)?.result);
}

/** Compute the table in a worker (once per texture data). Resolves when done; never rejects. */
export function prepareEnvCdf(tex) {
    if (!supported(tex)) return Promise.resolve();
    const known = entryOf(tex);
    if (known) return known.promise;
    const { data, width, height } = tex.image;
    const entry = { signature: signature(tex.image), result: null, promise: null };
    entry.promise = new Promise(resolve => {
        const worker = new Worker(new URL('./env-cdf-worker.js', import.meta.url), { type: 'module' });
        const done = result => { worker.terminate(); entry.result = result; resolve(); };
        worker.onmessage = ({ data: result }) => done(result);
        // fallback: the library computes it itself
        worker.onerror = e => { console.warn('[EnvCdf] worker failed:', e.message); cache.delete(data); done(null); };
        worker.postMessage({ data, width, height });   // copy – the texture keeps its data
    });
    cache.set(data, entry);
    return entry.promise;
}

/**
 * Called by the patched EquirectHdrInfoNode.updateFrom(envMap): fill `info` from a ready result.
 * Mirrors EquirectHdrInfoUniform.updateFrom (preprocessEnvMap for half float without flipY = clone with own
 * source). false = not ready → the library computes it itself.
 */
export function applyEnvCdf(info, envMap) {
    const result = entryOf(envMap)?.result;
    if (!result) return false;
    const map = envMap.clone();
    map.source = new TextureSource({ ...map.image });
    map.wrapS = RepeatWrapping;
    map.wrapT = ClampToEdgeWrapping;
    const { width, height } = map.image;
    info.dispose();
    info.marginalWeights.image = { width: height, height: 1, data: result.marginal };
    info.marginalWeights.needsUpdate = true;
    info.conditionalWeights.image = { width, height, data: result.conditional };
    info.conditionalWeights.needsUpdate = true;
    info.totalSum = result.totalSum;
    info.map = map;
    return true;
}
