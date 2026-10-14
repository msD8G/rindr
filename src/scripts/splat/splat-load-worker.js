// Load worker for Gaussian splats: reads PLY (streamed) / SOG from a dropped file or URL and converts it
// into the compact layout of splat-formats.js. The main thread terminates the worker to abort.
import { readPly, readSog, readZip, samplePly, beginInfo, plyHeaderOf, parsePlyHeader, plyKind, splatPlyLayout } from './splat-formats.js';

// Lossless WebP → RGBA without premultiplication. A 2D canvas stores premultiplied colours (SOG keeps the
// opacity in alpha – rgb of transparent splats would be lost), WebGL with UNPACK_PREMULTIPLY_ALPHA = false
// and no colour conversion returns the exact bytes.
let gl = null;
async function decodeImage(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const { width, height } = bitmap;
    gl ??= new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false });
    if (!gl) {   // fallback (lossy for transparent pixels)
        const ctx = new OffscreenCanvas(width, height).getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return { width, height, rgba: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer) };
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);   // row 0 = first image row
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    bitmap.close();
    return { width, height, rgba };
}

self.onmessage = async ({ data }) => {
    const { file, url, name, options } = data;
    const total = file?.size ?? 0;
    const progress = fraction => self.postMessage({ type: 'progress', fraction });
    // Progressive display: with shared buffers the main thread gets them right after the first block
    // ('begin') and then the number of splats read so far ('loaded', throttled)
    let lastLoaded = 0;
    const stream = {
        onBegin: (builder, estimate) => { if (builder.shared) self.postMessage({ type: 'begin', data: beginInfo(builder, estimate) }); },
        onLoaded: (ranges, shRanges = ranges) => {
            const now = performance.now();
            if (now - lastLoaded < 100) return;
            lastLoaded = now;
            self.postMessage({ type: 'loaded', ranges, shRanges });
        },
    };
    try {
        let result;
        if (/\.sog$/i.test(name)) {
            const buffer = file ? await file.arrayBuffer() : await (await fetchOk(url)).arrayBuffer();
            const zip = readZip(buffer);
            const get = n => { const f = zip.get(n); if (!f) throw new Error(`SOG: ${n} missing`); return f(); };
            result = await readSog(get, decodeImage, { ...options, ...stream, onProgress: progress });
        } else {
            let body, size = total;
            if (file) body = file.stream();
            else {
                const res = await fetchOk(url);
                size = +res.headers.get('content-length') || 0;
                body = res.body;
            }
            let last = 0;
            // dropped file: bounds from rows sampled across the file (centre of the reveal circle)
            const sample = file ? await sampleFile(file).catch(() => null) : null;
            result = await readPly(body.getReader(), {
                ...options, ...stream, estimate: sample?.estimate, shRange: sample?.shRange,
                onProgress: bytes => {
                    const now = performance.now();
                    if (size && now - last > 100) { last = now; progress(bytes / size); }
                },
            });
        }
        const shared = buf => typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer;
        const transfer = [result.a, result.b, result.sh, result.pickIndex, result.pickRadius].filter(v => v && !shared(v.buffer)).map(v => v.buffer);
        self.postMessage({ type: 'done', result }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};

async function fetchOk(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res;
}

// dropped splat PLY: bounds + SH range from rows across the whole file (random access)
async function sampleFile(file) {
    const head = plyHeaderOf(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
    if (!head) return null;
    const header = parsePlyHeader(head.text);
    if (header.format !== 'binary_little_endian' || plyKind(header) !== 'splat') return null;
    return samplePly(splatPlyLayout(header, head.size), (a, b) => file.slice(a, b).arrayBuffer());
}
