// Soft transition between the path tracer's successive images (pathtracer.js, end of the image chain): the low
// resolution orbit image → the first full sample → the refinement stages → the denoised result. Every frame the
// shown image moves a little towards the new one (exponential, PATHTRACING.fadeMs) instead of jumping.
// Two canvas-size targets in turn: shown = mix(previous shown, new, k).
import * as THREE from 'three/webgpu';
import { compileAsync } from './shader-compile.js';
import { texture, uniform, screenUV, mix } from 'three/tsl';

export class ImageFade {
    constructor(renderer) {
        this.renderer = renderer;
        const rt = () => {
            const t = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false,
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
            t.texture.name = 'ImageFade';
            return t;
        };
        this._targets = [rt(), rt()];
        this._index = 0;
        this.k = uniform(1);
        // full-screen pass like motion-denoise.js (own plane + camera, screenUV – compileAsync sees the same shader)
        this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this._quad.name = 'ImageFade';
        this._quad.frustumCulled = false;
        this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        // material i writes target i and reads the other one
        this._inputs = [texture(null), texture(null)];
        this._materials = this._targets.map((_, i) => {
            const m = new THREE.NodeMaterial();
            m.fragmentNode = mix(texture(this._targets[1 - i].texture).sample(screenUV), this._inputs[i].sample(screenUV), this.k);
            m.depthTest = m.depthWrite = false;
            m.toneMapped = false;
            return m;
        });
    }

    /** Compile both passes asynchronously for input textures like `source` */
    compile(source) {
        const r = this.renderer, target = r.getRenderTarget();
        const jobs = [];
        try {
            this._materials.forEach((m, i) => {
                this._inputs[i].value ??= source;
                r.setRenderTarget(this._targets[i]);
                this._quad.material = m;
                jobs.push(compileAsync(r, this._quad, this._camera));
            });
        } finally {
            r.setRenderTarget(target);
        }
        return Promise.all(jobs);
    }

    /** Move the shown image towards `source` by k (1 = show it as it is) – returns the shown image */
    render(source, k, width, height) {
        const r = this.renderer;
        r.initTexture(source);
        for (const t of this._targets) {
            if (t.width !== width || t.height !== height) { t.setSize(width, height); k = 1; }
        }
        const i = this._index;
        this._index = 1 - i;
        this.k.value = k;
        this._inputs[i].value = source;
        const target = r.getRenderTarget(), autoClear = r.autoClear;
        r.autoClear = true;
        try {
            r.setRenderTarget(this._targets[i]);
            this._quad.material = this._materials[i];
            r.render(this._quad, this._camera);
        } finally {
            r.setRenderTarget(target);
            r.autoClear = autoClear;
        }
        return this._targets[i].texture;
    }

    dispose() {
        for (const t of this._targets) t.dispose();
        for (const m of this._materials) m.dispose();
        this._quad.geometry.dispose();
    }
}
