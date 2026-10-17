// UV test pattern (wish of the user): 6 × 6 cells labelled A1 … F6 (rows A–F top → bottom, columns 1–6 left →
// right), corner colours blended across the whole square (top left green, top right yellow, bottom left blue,
// bottom right red), every other cell darker, grid lines (quarter lines faint) and a circle in the middle – stretching,
// seams, mirrored or rotated UVs show at a glance. Drawn once on a canvas (no image file). Used by the material
// previews' backdrop (material-thumbs.js, also sampled on the CPU for the traced glass refraction) and the UV view
// mode (viewer.js).
import * as THREE from 'three/webgpu';

const SIZE = 1024;
const CELLS = 6;
const CORNERS = { tl: [63, 174, 90], tr: [232, 200, 58], bl: [58, 111, 216], br: [216, 74, 58] };

let canvas = null, pixels = null, texture = null;

function draw() {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    // corner blend, bilinear per pixel row/column
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
        const fy = y / (SIZE - 1);
        for (let x = 0; x < SIZE; x++) {
            const fx = x / (SIZE - 1), o = (y * SIZE + x) * 4;
            const dark = ((Math.floor(x / (SIZE / CELLS)) + Math.floor(y / (SIZE / CELLS))) % 2) ? 0.78 : 1;
            for (let c = 0; c < 3; c++) {
                const top = CORNERS.tl[c] * (1 - fx) + CORNERS.tr[c] * fx;
                const bottom = CORNERS.bl[c] * (1 - fx) + CORNERS.br[c] * fx;
                img.data[o + c] = (top * (1 - fy) + bottom * fy) * dark;
            }
            img.data[o + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const cell = SIZE / CELLS;
    // grid: quarter lines faint, cell borders stronger
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 1; i < CELLS * 4; i++) {
        if (i % 4 === 0) continue;
        const p = i * cell / 4;
        ctx.moveTo(p, 0); ctx.lineTo(p, SIZE);
        ctx.moveTo(0, p); ctx.lineTo(SIZE, p);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let i = 0; i <= CELLS; i++) {
        const p = Math.min(Math.max(i * cell, 2), SIZE - 2);
        ctx.moveTo(p, 0); ctx.lineTo(p, SIZE);
        ctx.moveTo(0, p); ctx.lineTo(SIZE, p);
    }
    ctx.stroke();
    // circle in the middle (shows non-uniform stretching)
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.stroke();
    // labels
    ctx.font = `bold ${Math.round(cell * 0.36)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (let r = 0; r < CELLS; r++) {
        for (let c = 0; c < CELLS; c++) {
            const label = String.fromCharCode(65 + r) + (c + 1);
            const x = (c + 0.5) * cell, y = (r + 0.5) * cell;
            ctx.lineWidth = 8;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.strokeText(label, x, y);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, x, y);
        }
    }
    pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
}

/** The pattern as a texture (sRGB, repeating, mip-mapped) – shared */
export function uvCheckerTexture() {
    if (!texture) {
        if (!canvas) draw();
        texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = 8;
    }
    return texture;
}

/** Linear colour of the pattern at (u, v) (v up, like the texture; repeating), into `out` */
export function sampleUvChecker(u, v, out) {
    if (!pixels) draw();
    const x = ((Math.floor(u * SIZE) % SIZE) + SIZE) % SIZE;
    const y = ((Math.floor((1 - v) * SIZE) % SIZE) + SIZE) % SIZE;
    const o = (y * SIZE + x) * 4;
    for (let c = 0; c < 3; c++) out[c] = SRGB_TO_LINEAR[pixels[o + c]];
    return out;
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
    const s = i / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});
