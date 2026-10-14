// Loads a Radiance HDR (.hdr, RGBE) or OpenEXR (.exr, via three.js EXRLoader – all common
// compressions) and downscales it with a box filter to at most MAX_WIDTH pixels width. The files in public/hdr are 8000–10000 px wide –
// at full resolution that would be 256+ MB half float, ~4k is enough for light and background.
// Output: RGBA half float, row 0 = bottom (like ProceduralEquirectTexture, flipY = false).
import { DataUtils, FloatType } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

const MAX_WIDTH = 4096;

self.onmessage = async ({ data: { url, maxWidth = MAX_WIDTH } }) => {
    try {
        const buffer = await download(url, (loaded, total) => self.postMessage({ type: 'progress', loaded, total }));
        self.postMessage({ type: 'progress', decoding: true });
        const bytes = new Uint8Array(buffer);
        // OpenEXR magic number 76 2f 31 01
        const isExr = bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01;
        const result = isExr ? decodeExr(buffer, maxWidth) : decode(bytes, maxWidth);
        self.postMessage({ type: 'done', ...result }, [result.data.buffer]);
    } catch (e) {
        self.postMessage({ type: 'error', message: e.message || String(e) });
    }
};

async function download(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HDR not found (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total) return res.arrayBuffer();
    const out = new Uint8Array(total);
    const reader = res.body.getReader();
    let loaded = 0, last = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.set(value, loaded);
        loaded += value.length;
        if (loaded - last > 4e6) { last = loaded; onProgress(loaded, total); }
    }
    return out.buffer;
}

function decode(bytes, maxWidth) {
    // Header: text lines up to the empty line, then resolution "-Y H +X W"
    let pos = 0;
    const line = () => {
        let s = '';
        while (pos < bytes.length && bytes[pos] !== 10) s += String.fromCharCode(bytes[pos++]);
        pos++;
        return s;
    };
    if (!line().startsWith('#?')) throw new Error('Not a Radiance HDR file');
    for (;;) {
        const l = line();
        if (l === '') break;
        if (l.startsWith('FORMAT=') && l !== 'FORMAT=32-bit_rle_rgbe') throw new Error(`HDR format not supported: ${l}`);
        if (pos >= bytes.length) throw new Error('HDR header incomplete');
    }
    const res = line().match(/^-Y (\d+) \+X (\d+)$/);
    if (!res) throw new Error('HDR orientation not supported');
    const height = +res[1], width = +res[2];

    const f = Math.max(1, Math.ceil(width / maxWidth));
    const ow = Math.floor(width / f), oh = Math.floor(height / f);
    const out = new Uint16Array(ow * oh * 4);
    const acc = new Float32Array(ow * 3);
    const scan = new Uint8Array(width * 4);   // R…, G…, B…, E… (channels separate) or RGBE interleaved
    const inv = 1 / (f * f);

    for (let y = 0; y < oh * f; y++) {
        const planar = readScanline(bytes, pos, scan, width);
        pos = planar.pos;
        for (let ox = 0, x = 0; ox < ow; ox++) {
            let r = 0, g = 0, b = 0;
            for (let k = 0; k < f; k++, x++) {
                let R, G, B, E;
                if (planar.planar) { R = scan[x]; G = scan[width + x]; B = scan[2 * width + x]; E = scan[3 * width + x]; }
                else { const i = 4 * x; R = scan[i]; G = scan[i + 1]; B = scan[i + 2]; E = scan[i + 3]; }
                if (E === 0) continue;
                const s = Math.pow(2, E - 136);   // 2^(E-128) / 256
                r += R * s; g += G * s; b += B * s;
            }
            acc[3 * ox] += r; acc[3 * ox + 1] += g; acc[3 * ox + 2] += b;
        }
        if ((y + 1) % f) continue;
        // the file runs top to bottom, the texture bottom to top
        const row = oh - 1 - Math.floor(y / f);
        for (let ox = 0; ox < ow; ox++) {
            const o = 4 * (row * ow + ox);
            out[o] = DataUtils.toHalfFloat(Math.min(acc[3 * ox] * inv, 65504));
            out[o + 1] = DataUtils.toHalfFloat(Math.min(acc[3 * ox + 1] * inv, 65504));
            out[o + 2] = DataUtils.toHalfFloat(Math.min(acc[3 * ox + 2] * inv, 65504));
            out[o + 3] = 0x3c00;   // 1.0
        }
        acc.fill(0);
    }
    return { data: out, width: ow, height: oh, sourceWidth: width, sourceHeight: height };
}

// OpenEXR: EXRLoader delivers float RGBA (or fewer channels), rows already bottom to top
// (three.js uses the data directly with flipY = false) – only box-downscale + half float.
function decodeExr(buffer, maxWidth) {
    const loader = new EXRLoader();
    loader.setDataType(FloatType);
    const { data, width, height } = loader.parse(buffer);
    const channels = data.length / (width * height);
    const f = Math.max(1, Math.ceil(width / maxWidth));
    const ow = Math.floor(width / f), oh = Math.floor(height / f);
    const out = new Uint16Array(ow * oh * 4);
    const inv = 1 / (f * f);
    for (let oy = 0; oy < oh; oy++) {
        for (let ox = 0; ox < ow; ox++) {
            let r = 0, g = 0, b = 0;
            for (let dy = 0; dy < f; dy++) {
                for (let dx = 0; dx < f; dx++) {
                    const i = ((oy * f + dy) * width + ox * f + dx) * channels;
                    const v = data[i];
                    r += v;
                    g += channels >= 3 ? data[i + 1] : v;
                    b += channels >= 3 ? data[i + 2] : v;
                }
            }
            const o = 4 * (oy * ow + ox);
            // negative/NaN values (rare in EXR) would break the importance sampling
            const half = x => DataUtils.toHalfFloat(Math.min(Math.max(x * inv || 0, 0), 65504));
            out[o] = half(r);
            out[o + 1] = half(g);
            out[o + 2] = half(b);
            out[o + 3] = 0x3c00;   // 1.0
        }
    }
    return { data: out, width: ow, height: oh, sourceWidth: width, sourceHeight: height };
}

// Read one scanline. New RLE: channels separately one after another; otherwise uncompressed (RGBE interleaved).
function readScanline(bytes, pos, scan, width) {
    const rle = width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && !(bytes[pos + 2] & 0x80);
    if (!rle) {
        if (pos + width * 4 > bytes.length) throw new Error('HDR data incomplete');
        scan.set(bytes.subarray(pos, pos + width * 4));
        return { pos: pos + width * 4, planar: false };
    }
    if (((bytes[pos + 2] << 8) | bytes[pos + 3]) !== width) throw new Error('HDR scanline: wrong width');
    pos += 4;
    for (let c = 0; c < 4; c++) {
        let i = c * width;
        const end = i + width;
        while (i < end) {
            let n = bytes[pos++];
            if (n > 128) {
                n -= 128;
                if (i + n > end) throw new Error('HDR data corrupt');
                scan.fill(bytes[pos++], i, i + n);
            } else {
                if (n === 0 || i + n > end) throw new Error('HDR data corrupt');
                scan.set(bytes.subarray(pos, pos + n), i);
                pos += n;
            }
            i += n;
        }
    }
    if (pos > bytes.length) throw new Error('HDR data incomplete');
    return { pos, planar: true };
}
