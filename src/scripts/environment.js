// Studio environment as an HDR equirect texture (generated on the CPU).
// Shared by the rasterizer (automatic PMREM) and the WebGPU path tracer –
// the path tracer needs an equirect texture with CPU data for importance sampling.
import { viewAngle, PERSPECTIVE_LIMIT } from './fisheye.js';
import * as THREE from 'three/webgpu';
import { ProceduralEquirectTexture } from 'three-gpu-pathtracer/src/textures/ProceduralEquirectTexture.js';
import { renderStudioHall } from './studio-hall.js';

// Built-in studio: procedural hall with light strips on the ceiling (studio-hall.js).
// At startup a small version on the main thread (1k, ~70 ms), the full one (renderStudioEnvironment, 4k) in a worker.
export function createStudioEnvironment(width = 1024, height = width / 2) {
    const data = renderStudioHall(width, height, new Uint16Array(width * height * 4), THREE.DataUtils.toHalfFloat);
    return studioTexture(data, width, height);
}

/** built-in studio in a worker (4k: sharp enough as a visible background) */
export function renderStudioEnvironment(width = 4096, height = width / 2) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./studio-hall-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data: msg }) => { worker.terminate(); resolve(studioTexture(msg.data, msg.width, msg.height)); };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'studio worker failed')); };
        worker.postMessage({ width, height });
    });
}

function studioTexture(data, width, height) {
    const texture = new THREE.DataTexture(
        data, width, height, THREE.RGBAFormat, THREE.HalfFloatType, THREE.EquirectangularReflectionMapping,
        THREE.RepeatWrapping, THREE.ClampToEdgeWrapping, THREE.LinearFilter, THREE.LinearFilter,
    );
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.name = 'Studio';
    texture.needsUpdate = true;
    return texture;
}

// Default background without HDRI: dark grey centre, fading to black towards the edges (vignette).
// As an equirect texture whose forward direction (-Z) follows the camera via backgroundRotation –
// this way it works in the rasterizer AND in the path tracer (which only knows equirect backgrounds;
// glass then shows it correctly too). Falloff over the image radius (corner = 1), hence regenerated
// when the field of view or aspect ratio changes.
const VIGNETTE_CENTER = 0.06;   // linear, before ACES -> approx. #3a3a3a

export class VignetteBackground {
    constructor(width = 512, height = 256) {
        this.texture = new ProceduralEquirectTexture(width, height);
        this.texture.name = 'Vignette';
        this._key = '';
    }

    /** adapt to the camera; true if the texture was regenerated */
    update(camera, scene) {
        scene.backgroundRotation.setFromQuaternion(camera.quaternion);
        const angle = viewAngle(camera);
        const key = angle.toFixed(1) + '/' + camera.aspect.toFixed(2);
        if (key === this._key) return false;
        this._key = key;
        // screen radius (half height = 1) of a direction at angle θ from the view axis: perspective
        // tan θ / tan(fov/2); beyond it fisheye (fisheye.js: θ = k·atan(ρ·tan(limit/2))) → ρ = tan(θ/k) / tan(limit/2)
        const k = Math.max(1, angle / PERSPECTIVE_LIMIT);
        const tanEdge = Math.tan(THREE.MathUtils.degToRad(Math.min(angle, PERSPECTIVE_LIMIT) / 2));
        const corner = Math.hypot(1, camera.aspect);
        this.texture.generationCallback = (polar, uv, coord, color) => {
            // direction as in three.js equirectUV (u = atan2(z, x) / 2π + 0.5) – setFromSpherical(polar)
            // would be rotated by 90° around y; uv.x is already u - 0.5 here
            const a = uv.x * 2 * Math.PI;
            const c = -Math.sin(a) * Math.sin(polar.phi);   // -z = cos of the angle to the view direction
            const half = Math.acos(Math.min(Math.max(c, -1), 1)) / k;
            let v = 0;
            if (half < Math.PI / 2 - 1e-4) {
                const r = Math.tan(half) / tanEdge / corner;
                v = VIGNETTE_CENTER * (1 - THREE.MathUtils.smoothstep(r, 0, 1.25));
            }
            color.setRGB(v, v, v);
        };
        this.texture.update();
        return true;
    }

    dispose() {
        this.texture.dispose();
    }
}

/**
 * Load an HDRI from public/hdr (decoded in a worker and downscaled to ≤ 4k width).
 * @param {string} url
 * @param {(p: {loaded?: number, total?: number, decoding?: boolean}) => void} [onProgress]
 * @returns {Promise<THREE.DataTexture>}
 */
export function loadHdri(url, onProgress) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./hdr-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data: msg }) => {
            if (msg.type === 'progress') { onProgress?.(msg); return; }
            worker.terminate();
            if (msg.type === 'error') { reject(new Error(msg.message)); return; }
            const texture = new THREE.DataTexture(
                msg.data, msg.width, msg.height, THREE.RGBAFormat, THREE.HalfFloatType, THREE.EquirectangularReflectionMapping,
                THREE.RepeatWrapping, THREE.ClampToEdgeWrapping, THREE.LinearFilter, THREE.LinearFilter,
            );
            texture.colorSpace = THREE.LinearSRGBColorSpace;
            texture.needsUpdate = true;
            if (msg.credit) texture.userData.credit = msg.credit;   // copyright holder from the file's metadata
            resolve(texture);
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'HDR worker failed')); };
        worker.postMessage({ url });
    });
}

/** File names of the HDRIs in public/hdr (written into the page at build time, see index.astro) */
export function listHdris() {
    try {
        return JSON.parse(document.getElementById('hdr-list')?.textContent || '[]');
    } catch {
        return [];
    }
}
