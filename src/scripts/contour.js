// Contour lines of toon/outline materials (material param `contour`, material.userData.contour = { color, width }).
// Like the highlight (highlight.js) a screen-space pass over the finished image – raster AND path-traced image:
//   1. normals (view space) + depth of everything visible into `geo` (own depth buffer)
//   2. the meshes with a contour material: contour colour + width into `mask`, depth-tested against 1 (hidden
//      parts get no lines); grouped by colour/width, each group with its own override material
//   3. full-screen quad: outline outside the masked area (like the selection outline, `width` px) + the
//      important inner edges (depth steps, sharp creases; half width) → lines in that mesh's contour colour
// Drawn before export/AI capture (viewer.js), so the lines are part of saved images.
import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, screenUV, vec2, vec3, vec4, float, normalView, positionView, max, abs, dot, select, normalize } from 'three/tsl';

const LAYER = 29;   // mask pass only

export class ContourPass {
    /**
     * @param {THREE.WebGPURenderer} renderer
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {{ roots: () => THREE.Object3D[], hide?: () => THREE.Object3D[], depthScale?: () => number }} opts
     *   roots = model roots, hide = objects not to include (ground disc …), depthScale = typical view distance
     */
    constructor(renderer, scene, camera, { roots, hide = () => [], depthScale = () => 1 }) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.roots = roots;
        this.hide = hide;
        this.getDepthScale = depthScale;
        this.enabled = true;

        const rt = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        this.geo = rt();                  // rgb = normal (view) · 0.5 + 0.5, a = view depth
        this.mask = rt();                 // rgb = contour colour, a = width (px) / 16
        this._setDepth(1, 1);
        this._size = new THREE.Vector2();

        // 1. normal + depth of everything (depth / distance to the orbit centre: stays in the half float range for
        // any scene size, the edge test is relative anyway)
        this.depthScale = uniform(1);
        // plain NodeMaterial with fragmentNode: the values are written as they are (MeshBasicNodeMaterial added
        // environment/output handling – the decoded normals came back too short and turned)
        this.geoMaterial = new THREE.NodeMaterial();
        this.geoMaterial.fragmentNode = vec4(normalView.mul(0.5).add(0.5), positionView.z.negate().div(this.depthScale));
        this.geoMaterial.toneMapped = false;
        // never blended: three.js sets `transparent` of the override material from the scene material (e.g. parts
        // fading in) and the pass did blend (large assembly, opaque materials) – a surface drawn twice at the same depth
        // (touching parts, coincident faces) then wrote a + a·(1 − a) as depth (1.24 → 0.94): surfaces apparently in
        // front of everything, lines of hidden edges all over the objects
        this.geoMaterial.blending = THREE.NoBlending;
        // front faces like the library materials (FrontSide): with DoubleSide the pass saw faces the image does not
        // show (back faces through gaps of the tessellation) → whole areas counted as creases
        this._maskMaterials = new Map();   // "color|width" -> material

        // 3. lines
        this.texel = uniform(new THREE.Vector2(1, 1));
        this.maxWidth = uniform(1.5);   // widest contour of this frame (px) – search radius of the outline
        this.pixelRatio = uniform(1);
        const geoTex = texture(this.geo.texture), maskTex = texture(this.mask.texture);
        // a) outline: pixels outside a contour object's (visible) area within the line width – like the selection
        //    outline, thick and closed, also over the background and over objects behind
        // b) inside the object only the important edges, thinner: depth steps (second difference across the centre)
        //    and sharp creases; small bends and tessellation stay line-free (flat cel look)
        const lines = Fn(() => {
            const uv = screenUV;
            const c = geoTex.sample(uv), cm = maskTex.sample(uv);
            const inside = cm.a.greaterThan(0);
            const result = vec4(0).toVar();
            const width = cm.a.max(float(1 / 16)).mul(16).mul(this.pixelRatio);   // own width (inside)
            const outerW = float(this.maxWidth).mul(this.pixelRatio);              // search radius outside
            // a) outline: nearest masked neighbour in 8 directions at 1/3, 2/3, 1 of its width
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
                for (const k of [1 / 3, 2 / 3, 1]) {
                    const o = vec2(dx, dy).mul(this.texel).mul(outerW.mul(k));
                    const nm = maskTex.sample(uv.add(o));
                    // the neighbour's own width decides whether this distance is still on its outline
                    const reach = nm.a.mul(16).mul(this.pixelRatio);
                    const hit = inside.not().and(nm.a.greaterThan(0)).and(outerW.mul(k).lessThanEqual(reach.add(0.5)));
                    result.assign(select(hit.and(result.a.equal(0)), vec4(nm.rgb, 1), result));
                }
            }
            // b) important inner edges (half the width)
            const depth = v => select(v.a.greaterThan(0), v.a, float(1e6));
            const dc = depth(c);
            for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
                const o = vec2(dx, dy).mul(this.texel).mul(width.mul(0.5).max(1));
                const a = geoTex.sample(uv.add(o)), b = geoTex.sample(uv.sub(o));
                const lap = abs(depth(a).add(depth(b)).sub(dc.mul(2))).div(dc.min(depth(a)).min(depth(b)).max(1e-6));
                const na = normalize(a.rgb.mul(2).sub(1)), nb = normalize(b.rgb.mul(2).sub(1));
                const crease = dot(na, nb).lessThan(0.45).and(a.a.greaterThan(0)).and(b.a.greaterThan(0));
                const edge = lap.greaterThan(0.15).or(crease);
                result.assign(select(inside.and(edge).and(result.a.equal(0)), vec4(cm.rgb, 1), result));
            }
            return result;
        })();
        this.overlayMaterial = new THREE.NodeMaterial();
        this.overlayMaterial.fragmentNode = lines;
        this.overlayMaterial.transparent = true;
        this.overlayMaterial.depthTest = false;
        this.overlayMaterial.depthWrite = false;
        this.overlayMaterial.toneMapped = false;
        this.quad = new THREE.QuadMesh(this.overlayMaterial);
    }

    // one depth texture for both targets (pass 2 is depth-tested against pass 1); created anew for every size –
    // resizing a shared one left the GPU texture at its first size (WebGPU: attachment size mismatch)
    _setDepth(w, h) {
        this.geo.depthTexture?.dispose();
        const depth = new THREE.DepthTexture(w, h);
        this.geo.depthTexture = depth;
        this.mask.depthTexture = depth;
    }

    _maskMaterial(color, width) {
        const key = `${color}|${width}`;
        let m = this._maskMaterials.get(key);
        if (!m) {
            m = new THREE.NodeMaterial();
            // components passed directly: vec3(THREE.Color) came out as 0 (white contours were black)
            const c = new THREE.Color(color);
            m.fragmentNode = vec4(c.r, c.g, c.b, Math.min(Math.max(width, 0.5), 15) / 16);
            m.toneMapped = false;
            m.blending = THREE.NoBlending;   // see geoMaterial
            m.depthWrite = false;
            m.depthFunc = THREE.LessEqualDepth;
            // pass 1 draws batched meshes as InstancedMesh (render-batcher.js), this pass the meshes themselves –
            // the same surface may come out with a slightly different depth; the bias keeps it inside the mask
            m.polygonOffset = true;
            m.polygonOffsetFactor = -1;
            m.polygonOffsetUnits = -4;
            this._maskMaterials.set(key, m);
        }
        return m;
    }

    // visible meshes with a contour material, grouped by colour/width
    _groups() {
        const groups = new Map();
        const visit = o => {
            if (!o.visible) return;
            const c = o.isMesh && !o.isSplat && !Array.isArray(o.material) ? o.material?.userData?.contour : null;
            if (c) {
                const key = `${c.color}|${c.width}`;
                if (!groups.has(key)) groups.set(key, { color: c.color, width: c.width, meshes: [] });
                groups.get(key).meshes.push(o);
            }
            for (const child of o.children) visit(child);
        };
        for (const root of this.roots()) if (root) visit(root);
        return [...groups.values()];
    }

    /** Draw the contour lines over the current image (render target as set by the caller, usually the canvas) */
    render() {
        if (!this.enabled) return;
        const groups = this._groups();
        if (!groups.length) return;
        const { renderer, scene, camera } = this;
        renderer.getDrawingBufferSize(this._size);
        if (this.geo.width !== this._size.x || this.geo.height !== this._size.y) {
            this.geo.setSize(this._size.x, this._size.y);
            this.mask.setSize(this._size.x, this._size.y);
            this._setDepth(this._size.x, this._size.y);
        }
        this.texel.value.set(1 / this._size.x, 1 / this._size.y);
        this.pixelRatio.value = renderer.getPixelRatio();
        this.depthScale.value = Math.max(this.getDepthScale(), 1e-6);
        this.maxWidth.value = Math.max(...groups.map(g => Math.min(Math.max(g.width, 0.5), 15)));

        const prev = {
            target: renderer.getRenderTarget(), autoClear: renderer.autoClear, background: scene.background,
            backgroundNode: scene.backgroundNode, override: scene.overrideMaterial, mask: camera.layers.mask,
            clearAlpha: renderer.getClearAlpha(), toneMapping: renderer.toneMapping,
        };
        const clearColor = renderer.getClearColor(new THREE.Color());
        const hidden = this.hide().filter(o => o?.visible);
        hidden.forEach(o => { o.visible = false; });
        scene.background = null;
        scene.backgroundNode = null;
        renderer.setClearColor(0x000000, 0);
        renderer.toneMapping = THREE.NoToneMapping;
        try {
            // 1. normals + depth of everything visible
            renderer.setRenderTarget(this.geo);
            renderer.autoClear = true;
            scene.overrideMaterial = this.geoMaterial;
            renderer.render(scene, camera);
            // 2. contour meshes: colour + width, depth-tested against 1 (same depth texture)
            this.mask.depthTexture = this.geo.depthTexture;
            renderer.setRenderTarget(this.mask);
            renderer.clear(true, false, false);   // colour only – the depth of pass 1 stays
            renderer.autoClear = false;
            camera.layers.set(LAYER);
            for (const g of groups) {
                g.meshes.forEach(m => m.layers.enable(LAYER));
                scene.overrideMaterial = this._maskMaterial(g.color, g.width);
                renderer.render(scene, camera);
                g.meshes.forEach(m => m.layers.disable(LAYER));
            }
        } finally {
            camera.layers.mask = prev.mask;
            scene.overrideMaterial = prev.override;
            scene.background = prev.background;
            scene.backgroundNode = prev.backgroundNode;
            hidden.forEach(o => { o.visible = true; });
            renderer.setClearColor(clearColor, prev.clearAlpha);
            renderer.toneMapping = prev.toneMapping;
            renderer.setRenderTarget(prev.target);
        }
        // 3. lines over the image
        renderer.autoClear = false;
        this.quad.render(renderer);
        renderer.autoClear = prev.autoClear;
    }
}
