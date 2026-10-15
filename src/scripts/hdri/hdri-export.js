// Export of a custom HDRI: Radiance .hdr (RGBE, own writer) or OpenEXR (three.js EXRExporter, half float, ZIP).
import * as THREE from 'three/webgpu';
import { EXRExporter } from 'three/addons/exporters/EXRExporter.js';

/** RGBA linear Float32 (row 0 = bottom) → .hdr bytes (flat RGBE scanlines, top row first) */
export function encodeHdr(rgba, width, height) {
    const header = new TextEncoder().encode(`#?RADIANCE\n# rindr HDRI editor\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
    const out = new Uint8Array(header.length + width * height * 4);
    out.set(header);
    let o = header.length;
    for (let y = height - 1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], m = Math.max(r, g, b);
            if (m < 1e-32) { o += 4; continue; }
            const e = Math.ceil(Math.log2(m) + 1e-9);
            const f = 256 / 2 ** e;
            out[o] = Math.min(255, r * f); out[o + 1] = Math.min(255, g * f); out[o + 2] = Math.min(255, b * f); out[o + 3] = e + 128;
            o += 4;
        }
    }
    return out;
}

/** RGBA half float (row 0 = bottom) → .exr bytes */
export async function encodeExr(half, width, height) {
    const tex = new THREE.DataTexture(half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    return new EXRExporter().parse(tex, { type: THREE.HalfFloatType, compression: 3 /* ZIP */ });
}

/** Save bytes as a file: "save as" dialog where available (Chrome/Edge), otherwise download */
export async function saveFile(bytes, name, mime, description) {
    const ext = name.slice(name.lastIndexOf('.'));
    if (window.showSaveFilePicker) {
        let handle;
        try {
            handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description, accept: { [mime]: [ext] } }] });
        } catch (e) {
            if (e.name === 'AbortError') return false;
            throw e;
        }
        const w = await handle.createWritable();
        await w.write(bytes);
        await w.close();
        return true;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
}
