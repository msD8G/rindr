// Worker of the HDRI editor: renders a description (hdri-render.js) and returns the half float data for the
// environment texture plus a tone-mapped 8-bit preview for the editor's canvas (rows top → bottom).
import { DataUtils } from 'three';
import { renderHdri } from './hdri-render.js';

self.onmessage = ({ data: msg }) => {
    try {
        const { doc, width, preview, half: wantHalf = true } = msg;
        const rgba = renderHdri(doc, width);
        const height = width >> 1;
        const half = wantHalf ? new Uint16Array(rgba.length) : null;
        if (half) for (let i = 0; i < rgba.length; i++) half[i] = DataUtils.toHalfFloat(Math.min(rgba[i], 65000));
        const pixels = preview ? previewPixels(rgba, width, height) : null;
        const transfer = [half?.buffer, pixels?.buffer].filter(Boolean);
        self.postMessage({ id: msg.id, width, height, half, pixels, float: msg.float ? rgba : null }, msg.float ? [...transfer, rgba.buffer] : transfer);
    } catch (e) {
        self.postMessage({ id: msg.id, error: e.message || String(e) });
    }
};

// ACES fit (Narkowicz) + sRGB, rows flipped (canvas: top first); 4 × 4 ordered dither against bands in gradients
const DITHER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16 - 0.5);
function previewPixels(rgba, width, height) {
    const out = new Uint8ClampedArray(width * height * 4);
    const aces = x => Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
    const srgb = v => Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
    for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * width * 4, dst = y * width * 4;
        for (let x = 0; x < width; x++) {
            const d = DITHER[(y & 3) * 4 + (x & 3)], i = x * 4;
            out[dst + i] = srgb(aces(rgba[src + i] * 0.8)) + d;
            out[dst + i + 1] = srgb(aces(rgba[src + i + 1] * 0.8)) + d;
            out[dst + i + 2] = srgb(aces(rgba[src + i + 2] * 0.8)) + d;
            out[dst + i + 3] = 255;
        }
    }
    return out;
}
