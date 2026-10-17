// Volumetric light shafts ("god rays" with real volume) – lens effect in all view modes (lens-effects.js).
// Instead of blurring bright parts of the image towards the sun (screen space: only works while the sun is in
// the picture, every bright pixel streaks), the air around the model is ray-marched against a shadow map from
// the sun: lit air scatters light towards the camera, air in the model's shadow does not → beams and shadow
// wedges that come from the 3D geometry (light through openings, the sun may lie outside the picture).
// - Sun = brightest point of the HDRI (viewer.js, same as lens flare), real light direction (environment
//   rotation, without the dome's latitude shift of the visible background).
// - Sun depth map: orthographic camera along the sun over the bounding sphere of the models, view depth / far
//   into a half-float target (1024²), only redrawn when the sun, the bounds or the scene changed (markDirty –
//   viewer.js calls it together with the light shadow maps).
// - Camera depth: the scene once more at half resolution (override material: modelSize / view depth,
//   0 = background) at full resolution, ground included (rays end on the floor), splats left out.
// - March (half resolution): per pixel 48 steps between camera and surface, only inside a sphere around the
//   models (radius = reach × model size, soft edge) – otherwise the whole air up to the horizon would glow;
//   start offset per pixel (interleaved gradient noise) against banding. Lit share × Henyey-Greenstein phase
//   (normalised to isotropic = 1: bright towards the sun) × light colour.
// - Two depth-aware blur passes (do not smear across edges of the model), joint bilateral upsampling to full
//   resolution (no halo along silhouettes), additively onto the image.
// - Fisheye (view angle above 100°, fisheye.js): view rays with the same mapping as raster/path tracer, camera
//   depth from a cube map (six 90° views) unwrapped with it – before, the shafts stayed perspective.
// Limits: section plane (depth passes ignore the cut).
import * as THREE from 'three/webgpu';
import { Fn, texture, cubeTexture, uniform, uv, vec2, vec3, vec4, float, dot, max, min, abs, exp, sqrt, length, normalize, smoothstep, select, positionView, fract, screenCoordinate, Loop, int } from 'three/tsl';
import { fisheyeEnabled, fisheyeDirectionNode, fisheyeOnNode } from './fisheye.js';

const SUN_SIZE = 1024;
const STEPS = 48;

export class VolumeShafts {
    constructor() {
        const rt = (type = THREE.HalfFloatType, depthBuffer = false) => {
            const t = new THREE.RenderTarget(1, 1, { type, depthBuffer });
            t.texture.minFilter = t.texture.magFilter = THREE.NearestFilter;
            return t;
        };
        this.sunTarget = rt(THREE.HalfFloatType, true);
        this.sunTarget.setSize(SUN_SIZE, SUN_SIZE);
        this.depthTarget = rt(THREE.HalfFloatType, true);
        this.march = rt();
        this.blurA = rt();
        this.blurB = rt();
        this.up = rt();   // full resolution (depth-aware upsampling)
        this.quad = new THREE.QuadMesh();
        this.quad.name = 'VolumeShafts';
        this.sunCamera = new THREE.OrthographicCamera();
        // fisheye (view angle above PERSPECTIVE_LIMIT): camera depth into a cube map, then unwrapped with the
        // fisheye mapping into depthTarget (a perspective depth cannot cover up to 240°)
        this.cubeTarget = new THREE.CubeRenderTarget(512, { type: THREE.HalfFloatType, depthBuffer: true });
        this.cubeCamera = new THREE.CubeCamera(0.1, 1000, this.cubeTarget);
        this.cubeRotation = uniform(new THREE.Matrix4());
        this.dirty = true;
        this._sig = '';
        this.light = null;   // { direction (world, towards the sun), color }

        this.u = {
            modelSize: uniform(1),
            sunFar: uniform(1),
            sunViewProj: uniform(new THREE.Matrix4()),
            sunView: uniform(new THREE.Matrix4()),
            camWorld: uniform(new THREE.Matrix4()),
            camPos: uniform(new THREE.Vector3()),
            tanHalf: uniform(new THREE.Vector2(1, 1)),   // tan of the half view angle x / y
            center: uniform(new THREE.Vector3()),
            radius: uniform(1),
            sunDir: uniform(new THREE.Vector3(0, 1, 0)),
            color: uniform(new THREE.Color(1, 1, 1)),
            anisotropy: uniform(0.6),
            bias: uniform(0.002),
            texel: uniform(new THREE.Vector2()),
            blurDir: uniform(new THREE.Vector2()),
        };
        const u = this.u;

        // depth passes (scene.overrideMaterial)
        this.sunDepthMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
        this.sunDepthMaterial.outputNode = vec4(positionView.z.negate().div(u.sunFar), 0, 0, 1);
        this.camDepthMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
        // distance from the camera (not view z): the same in every cube face of the fisheye depth
        this.camDepthMaterial.outputNode = vec4(u.modelSize.div(max(length(positionView), 1e-6)), 0, 0, 1);

        const sunDepth = texture(this.sunTarget.texture);
        const camDepth = texture(this.depthTarget.texture);

        // ray march
        this.marchMaterial = new THREE.NodeMaterial();
        this.marchMaterial.fragmentNode = Fn(() => {
            const p = uv();
            const inv = camDepth.sample(p).r;
            const ndc = vec2(p.x.mul(2).sub(1), float(1).sub(p.y.mul(2)));
            // view ray: perspective, or the fisheye mapping above PERSPECTIVE_LIMIT (fisheye.js, like raster/path tracer)
            const viewDir = select(fisheyeOnNode(), fisheyeDirectionNode(ndc), normalize(vec3(ndc.x.mul(u.tanHalf.x), ndc.y.mul(u.tanHalf.y), -1)));
            // background: far beyond the sphere
            const d = select(inv.greaterThan(1e-6), u.modelSize.div(max(inv, 1e-6)), u.radius.mul(1e3));
            const dir = normalize(u.camWorld.mul(vec4(viewDir, 0)).xyz);
            const tEnd = d;
            // sphere [t0, t1] ∩ [0, tEnd]
            const oc = u.camPos.sub(u.center);
            const b = dot(oc, dir);
            const disc = b.mul(b).sub(dot(oc, oc).sub(u.radius.mul(u.radius)));
            const h = sqrt(max(disc, 0));
            const t0 = max(b.negate().sub(h), 0);
            const t1 = min(b.negate().add(h), tEnd);
            const span = max(t1.sub(t0), 0).mul(select(disc.greaterThan(0), 1, 0));
            // interleaved gradient noise (Jimenez) – start offset per pixel
            const sc = screenCoordinate.xy;
            const jitter = fract(float(52.9829189).mul(fract(dot(sc, vec2(0.06711056, 0.00583715)))));
            const sum = float(0).toVar();
            Loop({ start: int(0), end: int(STEPS) }, ({ i }) => {
                const t = t0.add(span.mul(float(i).add(jitter).div(STEPS)));
                const pos = u.camPos.add(dir.mul(t));
                const sp = u.sunViewProj.mul(vec4(pos, 1));
                const suv = vec2(sp.x.mul(0.5).add(0.5), float(0.5).sub(sp.y.mul(0.5)));
                const ds = u.sunView.mul(vec4(pos, 1)).z.negate().div(u.sunFar);
                const occluder = sunDepth.sample(suv).r;
                const inside = suv.x.greaterThan(0).and(suv.x.lessThan(1)).and(suv.y.greaterThan(0)).and(suv.y.lessThan(1));
                const lit = select(inside.not().or(ds.lessThanEqual(occluder.add(u.bias))), 1, 0);
                // soft edge of the medium sphere
                const r = length(pos.sub(u.center)).div(u.radius);
                const density = float(1).sub(smoothstep(0.5, 1, r));
                sum.addAssign(float(lit).mul(density));
            });
            // lit length in radii × phase (Henyey-Greenstein, isotropic = 1)
            const g = u.anisotropy;
            const cosT = dot(dir, u.sunDir);
            const den = float(1).add(g.mul(g)).sub(g.mul(2).mul(cosT));
            const phase = float(1).sub(g.mul(g)).div(den.mul(sqrt(max(den, 1e-6))));
            // × 0.25: visible at the default strength 0.6 without turning into a white wall when facing the sun
            // (phase up to ~10) – unscaled the shadow wedges drowned in it, × 0.1 was hardly visible (tests Oct. 2026)
            const amount = sum.div(STEPS).mul(span).div(u.radius).mul(phase).mul(0.25);
            return vec4(vec3(u.color).mul(amount), 1);
        })();

        this.unwrapMaterial = new THREE.NodeMaterial();
        this.unwrapMaterial.fragmentNode = Fn(() => {
            const p = uv();
            const ndc = vec2(p.x.mul(2).sub(1), float(1).sub(p.y.mul(2)));
            const dir = this.cubeRotation.mul(vec4(fisheyeDirectionNode(ndc), 0)).xyz;
            return vec4(cubeTexture(this.cubeTarget.texture).sample(dir).r, 0, 0, 1);
        })();

        // depth-aware blur (9 taps, separable): weight falls with the difference in inverse depth
        this.blurSource = texture(null);
        this.blurMaterial = new THREE.NodeMaterial();
        this.blurMaterial.fragmentNode = Fn(() => {
            const p = uv();
            const c = camDepth.sample(p).r;
            const sum = vec3(0).toVar();
            const wsum = float(0).toVar();
            for (let k = -4; k <= 4; k++) {
                const q = p.add(u.blurDir.mul(u.texel).mul(k));
                const w = exp(abs(camDepth.sample(q).r.sub(c)).div(max(c, 0.05)).mul(-8)).mul(Math.exp(-(k * k) / 8));
                sum.addAssign(this.blurSource.sample(q).rgb.mul(w));
                wsum.addAssign(w);
            }
            return vec4(sum.div(max(wsum, 1e-6)), 1);
        })();

        // joint bilateral upsampling to full resolution: the 4 nearest half-resolution texels, bilinear weights ×
        // similarity of their depth to this pixel's depth – no halo/steps along the silhouettes
        const half = texture(this.blurB.texture);
        this.upMaterial = new THREE.NodeMaterial();
        this.upMaterial.fragmentNode = Fn(() => {
            const p = uv();
            const c = camDepth.sample(p).r;
            const hp = p.div(u.texel).sub(0.5);   // position in half-resolution texels
            const base = hp.floor();
            const f = hp.sub(base);
            const sum = vec3(0).toVar();
            const wsum = float(0).toVar();
            for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                const q = base.add(vec2(dx, dy)).add(0.5).mul(u.texel);
                const bw = (dx ? f.x : float(1).sub(f.x)).mul(dy ? f.y : float(1).sub(f.y));
                const w = bw.mul(exp(abs(camDepth.sample(q).r.sub(c)).div(max(c, 0.05)).mul(-16))).add(1e-4);
                sum.addAssign(half.sample(q).rgb.mul(w));
                wsum.addAssign(w);
            }
            return vec4(sum.div(wsum), 1);
        })();
    }

    /** Fisheye camera depth: six 90° views from the camera position into the cube, unwrapped into depthTarget */
    _fisheyeDepth(renderer, scene, camera) {
        const cube = this.cubeCamera;
        if (cube.coordinateSystem !== renderer.coordinateSystem) {
            cube.coordinateSystem = renderer.coordinateSystem;
            cube.updateCoordinateSystem();
        }
        camera.updateMatrixWorld();
        cube.position.setFromMatrixPosition(camera.matrixWorld);
        cube.updateMatrixWorld(true);
        cube.children.forEach((face, i) => {
            if (face.near !== camera.near || face.far !== camera.far) {
                face.near = camera.near;
                face.far = camera.far;
                face.updateProjectionMatrix();
            }
            face.layers.mask = camera.layers.mask;
            renderer.setRenderTarget(this.cubeTarget, i);
            renderer.render(scene, face);
        });
        this.cubeRotation.value.extractRotation(camera.matrixWorld);
        renderer.setRenderTarget(this.depthTarget);
        this.quad.material = this.unwrapMaterial;
        this.quad.render(renderer);
    }

    /** Result (composited additively by lens-effects.js) */


    get texture() {
        return this.up.texture;
    }

    /** Something in the scene changed (geometry, visibility, matrices) – sun depth map is redrawn */
    markDirty() {
        this.dirty = true;
    }

    /**
     * Light for this frame (null = none: the effect stays black)
     * @param {THREE.Vector3|null} direction world direction towards the sun
     * @param {THREE.Color} [color]
     */
    setLight(direction, color) {
        if (!direction) { this.light = null; return; }
        this.light ??= { direction: new THREE.Vector3(), color: new THREE.Color() };
        this.light.direction.copy(direction).normalize();
        this.light.color.copy(color || new THREE.Color(1, 1, 1));
    }

    /**
     * Draw depth passes + march + blur.
     * @param {THREE.WebGPURenderer} renderer
     * @param {{scene: THREE.Scene, camera: THREE.PerspectiveCamera, bounds: THREE.Sphere|null,
     *   modelSize: number, hide: THREE.Object3D[], ground: THREE.Mesh|null}} ctx
     *   bounds = bounding sphere of the shown models, hide = left out of both depth passes (splats, …),
     *   clouds = CloudSystem (clouds.js, optional): its volumes draw their own depth,
     *   ground = only in the camera depth (allowOverride = false, so switched on for it): rays end on the floor
     * @param {number} width full resolution (march and blur run at half of it)
     * @param {number} height
     * @param {{length: number, focus: number}} settings
     */
    render(renderer, ctx, width, height, settings) {
        const hw = Math.max(1, Math.ceil(width / 2)), hh = Math.max(1, Math.ceil(height / 2));
        for (const t of [this.depthTarget, this.up]) if (t.width !== width || t.height !== height) t.setSize(width, height);
        for (const t of [this.march, this.blurA, this.blurB]) if (t.width !== hw || t.height !== hh) t.setSize(hw, hh);
        const prevTarget = renderer.getRenderTarget(), prevAutoClear = renderer.autoClear;
        const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
        renderer.autoClear = true;
        const { scene, camera, bounds } = ctx;
        if (!this.light || !bounds || !(bounds.radius > 0)) {
            renderer.setClearColor(0x000000, 1);
            renderer.setRenderTarget(this.up);
            renderer.clear();
            renderer.setRenderTarget(prevTarget);
            renderer.setClearColor(prevClear, prevAlpha);
            renderer.autoClear = prevAutoClear;
            return;
        }
        const u = this.u, L = this.light.direction, R = bounds.radius;
        u.modelSize.value = Math.max(ctx.modelSize, 1e-6);
        u.sunDir.value.copy(L);
        u.color.value.copy(this.light.color);
        u.anisotropy.value = THREE.MathUtils.clamp(settings.focus, 0, 0.95);
        u.center.value.copy(bounds.center);
        u.radius.value = R * (0.75 + 2.25 * settings.length);   // medium: around the models, reach adjustable

        const hide = ctx.ground ? [...ctx.hide, ctx.ground] : ctx.hide;
        const prev = { background: scene.background, backgroundNode: scene.backgroundNode, override: scene.overrideMaterial, visible: hide.map(o => o.visible) };
        scene.background = null;
        scene.backgroundNode = null;
        hide.forEach(o => { o.visible = false; });

        // 1. sun depth map – only when something changed
        const sig = `${L.toArray().map(v => v.toFixed(5))}|${bounds.center.toArray().map(v => v.toPrecision(6))}|${R.toPrecision(6)}`;
        if (this.dirty || sig !== this._sig) {
            this.dirty = false;
            this._sig = sig;
            const cam = this.sunCamera;
            cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
            cam.near = 0; cam.far = 4 * R;
            cam.position.copy(bounds.center).addScaledVector(L, 2 * R);
            cam.up.set(Math.abs(L.y) > 0.99 ? 1 : 0, Math.abs(L.y) > 0.99 ? 0 : 1, 0);
            cam.lookAt(bounds.center);
            cam.updateProjectionMatrix();
            cam.updateMatrixWorld();
            u.sunFar.value = cam.far;
            u.sunView.value.copy(cam.matrixWorldInverse);
            u.sunViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
            u.bias.value = 3 / SUN_SIZE;   // ~1.5 texels of depth (range 4R over the map width 2R)
            scene.overrideMaterial = this.sunDepthMaterial;
            ctx.clouds?.beginDepth('sun', cam.far);   // cloud volumes: their shape, not their box (clouds.js)
            renderer.setClearColor(0xffffff, 1);
            renderer.setRenderTarget(this.sunTarget);
            renderer.render(scene, cam);
            ctx.clouds?.endDepth();
        }

        // 2. camera depth (full resolution, for the upsampling); the ground counts (rays end on the floor)
        const ground = ctx.ground, groundAllow = ground?.material.allowOverride;
        if (ground) { ground.visible = prev.visible[hide.length - 1]; ground.material.allowOverride = true; }
        scene.overrideMaterial = this.camDepthMaterial;
        ctx.clouds?.beginDepth('camera', u.modelSize.value);
        renderer.setClearColor(0x000000, 1);
        if (fisheyeEnabled()) this._fisheyeDepth(renderer, scene, camera);
        else {
            renderer.setRenderTarget(this.depthTarget);
            renderer.render(scene, camera);
        }
        ctx.clouds?.endDepth();
        if (ground) ground.material.allowOverride = groundAllow;

        scene.overrideMaterial = prev.override;
        scene.background = prev.background;
        scene.backgroundNode = prev.backgroundNode;
        hide.forEach((o, i) => { o.visible = prev.visible[i]; });

        // 3. march
        camera.updateMatrixWorld();
        u.camWorld.value.copy(camera.matrixWorld);
        camera.getWorldPosition(u.camPos.value);
        const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1);
        u.tanHalf.value.set(tanY * camera.aspect, tanY);
        const draw = (target, material) => { renderer.setRenderTarget(target); this.quad.material = material; this.quad.render(renderer); };
        draw(this.march, this.marchMaterial);

        // 4. blur (horizontal, vertical) at half resolution, 5. upsampling
        u.texel.value.set(1 / hw, 1 / hh);
        this.blurSource.value = this.march.texture; u.blurDir.value.set(1, 0); draw(this.blurA, this.blurMaterial);
        this.blurSource.value = this.blurA.texture; u.blurDir.value.set(0, 1); draw(this.blurB, this.blurMaterial);
        draw(this.up, this.upMaterial);

        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevClear, prevAlpha);
        renderer.autoClear = prevAutoClear;
    }
}
