// Ground shadow ("shadow catcher"): a large disc below the model that shows only the model's shadow –
// everywhere else the background behind it (HDRI, dome or vignette) shows through unchanged. No HDRI
// projection of its own, so it always matches the background and later also works for transparent images.
//
// Raster: ShadowNodeMaterial (shadow maps of the directional lights). Path tracer: material flag `matte`,
// the megakernel is patched to a real shadow catcher (shadow-catcher.js / shadow-catcher.patch.wgsl):
// background × share of the light (HDRI + lights) that reaches the ground point.
//
// Soft edge: the disc fades out radially (alpha map with smootherstep between fadeStart and fadeEnd) so
// the shadow area ends softly. The disc is built from rings of equal elevation as seen from the projection
// centre `height` above the ground (fine near the model, coarse far away); uv.v depends only on the radius,
// so a 1-pixel-wide alpha texture along v is enough (the path tracer supports alphaMap, green channel).
import * as THREE from 'three/webgpu';
import { texture, uniform } from 'three/tsl';
import { updateShadowCatcher } from './shadow-catcher.js';

const RINGS = 384;         // elevation steps (fine, otherwise kinks in the gradient -> rings on the ground)
const SEGMENTS = 128;      // azimuth segments
const MIN_ELEVATION = Math.atan(1 / 150);   // edge of the disc: radius = 150 · height
const FADE_TEXELS = 1024;  // resolution of the alpha map along v (whole range 0…1)
// raster preview: shadow maps give hard, fully black shadows – dampened to come closer to the soft
// path traced shadow (only via opacityNode: material.opacity is read by the path tracer as transparency)
const RASTER_SHADOW_OPACITY = 0.5;

export class GroundProjection {
    constructor() {
        // raster: only the shadow (transparent black); path tracer: matte = shadow catcher (patched kernel)
        this.material = new THREE.ShadowNodeMaterial({ transparent: true, opacity: 1 });
        this.material.matte = true;
        this._fadeNode = texture(new THREE.Texture());   // raster: same radial fade as the alpha map
        this._shadowOn = uniform(1);   // 0: disc only for the ground reflection (ground-reflection.js), no shadow
        this.material.opacityNode = this._fadeNode.g.mul(RASTER_SHADOW_OPACITY).mul(this._shadowOn);
        this.mesh = new THREE.Mesh(createGeometry(), this.material);
        this.mesh.name = 'GroundProjection';
        this.mesh.receiveShadow = true;
        this.mesh.castShadow = false;
        this.mesh.visible = false;
        this.mesh.renderOrder = -1;
        this.height = 1;          // projection height (model units)
        this.groundY = 0;
        this.strength = 1;        // shadow strength 0…1
        this._irradiance = null;  // E of the HDRI upper hemisphere (without environmentIntensity)
        this._texture = null;
        this._fadeKey = '';
    }

    /** Shadow shown (false: the disc is only there for the ground reflection / puddles) */
    set shadow(v) {
        this._shadowOn.value = v ? 1 : 0;
        this.strength = v ? 1 : 0;
    }

    get enabled() {
        return this.mesh.visible;
    }

    set enabled(v) {
        this.mesh.visible = v;
    }

    /** Set the HDRI (equirect DataTexture with CPU data) – its upward irradiance weights the shadow rays */
    setEnvironment(texture) {
        if (this._texture === texture) return;
        this._texture = texture;
        this._irradiance = upwardIrradiance(texture);
    }

    /**
     * Placement: ground at height groundY (world), projection height `height` above it;
     * soft edge from fadeStart to fadeEnd (distance from the centre, world units)
     */
    place(groundY, height, fadeStart = Infinity, fadeEnd = Infinity, x = 0, z = 0) {
        this.groundY = groundY;
        this.height = Math.max(height, 1e-6);
        this.mesh.position.set(x, groundY, z);   // centre of the scene's footprint
        this.mesh.scale.setScalar(this.height);
        this.mesh.updateMatrixWorld(true);
        this._updateFade(fadeStart / this.height, fadeEnd / this.height);
    }

    // alpha map along v: texel -> elevation below the horizon -> radius (in units of the height)
    _updateFade(start, end) {
        const key = `${start.toPrecision(5)}|${end.toPrecision(5)}`;
        if (key === this._fadeKey) return;
        this._fadeKey = key;
        const data = new Uint8Array(FADE_TEXELS * 4);
        for (let y = 0; y < FADE_TEXELS; y++) {
            const elevation = (0.5 - (y + 0.5) / FADE_TEXELS) * Math.PI;
            let a = 0;
            if (elevation > 0) {
                const r = 1 / Math.tan(elevation);
                const t = end > start ? Math.min(Math.max((r - start) / (end - start), 0), 1) : (r < end ? 0 : 1);
                a = 1 - t * t * t * (t * (t * 6 - 15) + 10);   // 1 - smootherstep
            }
            data.fill(Math.round(a * 255), y * 4, y * 4 + 4);
        }
        // new texture instead of updating the data: the path tracer packs textures when materials change
        const map = new THREE.DataTexture(data, 1, FADE_TEXELS, THREE.RGBAFormat, THREE.UnsignedByteType);
        map.magFilter = map.minFilter = THREE.LinearFilter;
        map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
        map.needsUpdate = true;
        this.material.alphaMap?.dispose();
        this.material.alphaMap = map;   // path tracer
        this._fadeNode.value = map;     // raster
        this.material.needsUpdate = true;
    }

    /** Update the shadow catcher weights (after changes of HDRI, intensity or lights) */
    update(scene) {
        updateShadowCatcher(scene, this._irradiance, { enabled: this.enabled, strength: this.strength });
    }
}

// disc in units of the projection height (projection centre at y = 1)
function createGeometry() {
    const positions = [], uvs = [], normals = [], index = [];
    const cols = SEGMENTS + 1;
    for (let j = 0; j <= RINGS; j++) {
        // elevation below the horizon: from 90° (straight down) to MIN_ELEVATION
        const t = j / RINGS;
        const alpha = Math.PI / 2 - t * (Math.PI / 2 - MIN_ELEVATION);
        const r = 1 / Math.tan(alpha);
        const v = 0.5 - alpha / Math.PI;
        for (let i = 0; i <= SEGMENTS; i++) {
            const u = i / SEGMENTS;
            const phi = (u - 0.5) * 2 * Math.PI;       // u = atan2(z, x) / 2π + 0.5
            positions.push(r * Math.cos(phi), 0, r * Math.sin(phi));
            uvs.push(u, v);
            normals.push(0, 1, 0);
        }
    }
    for (let j = 0; j < RINGS; j++) {
        for (let i = 0; i < SEGMENTS; i++) {
            const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
            // counter-clockwise seen from above
            index.push(a, b, c, b, d, c);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(index);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
}

// E = ∫ L(ω) · max(ω_y, 0) dω over the equirect texture (half or float data)
function upwardIrradiance(texture) {
    const { data, width, height } = texture.image;
    const read = texture.type === THREE.HalfFloatType ? x => THREE.DataUtils.fromHalfFloat(x) : x => x;
    const e = new THREE.Color(0, 0, 0);
    const dPhi = 2 * Math.PI / width, dTheta = Math.PI / height;
    for (let y = 0; y < height; y++) {
        const lat = ((y + 0.5) / height - 0.5) * Math.PI;   // v = asin(dir.y)/π + 0.5
        const up = Math.sin(lat);
        if (up <= 0) continue;
        const w = up * Math.cos(lat) * dPhi * dTheta;
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            e.r += read(data[i]) * w;
            e.g += read(data[i + 1]) * w;
            e.b += read(data[i + 2]) * w;
        }
    }
    return e;
}
