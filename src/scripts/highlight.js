// Outline highlight for selection and mouse-over.
// Works in the raster view AND on top of the path-traced image: the highlighted meshes are
// rendered as a mask into a texture (R = selection, G = mouse-over), then a full-screen quad draws
// the outline transparently over the finished image.
import * as THREE from 'three/webgpu';
import { texture, screenUV, vec2, vec3, vec4, float, max, uniform, Fn, mix, clamp } from 'three/tsl';

const LAYER = 31;   // dedicated layer, only for the mask pass

export class Highlighter {
    constructor(renderer, scene, camera) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.selected = [];
        this.hovered = [];

        this.maskTarget = new THREE.RenderTarget(1, 1, { depthBuffer: false });
        this.maskTarget.texture.name = 'highlightMask';

        // mask materials: no depth test (whole silhouette), additive -> R/G independent
        const maskMaterial = color => {
            const m = new THREE.MeshBasicNodeMaterial({ color, depthTest: false, depthWrite: false });
            m.blending = THREE.AdditiveBlending;
            m.side = THREE.DoubleSide;
            m.toneMapped = false;
            return m;
        };
        this.selectedMaterial = maskMaterial(0xff0000);
        this.hoveredMaterial = maskMaterial(0x00ff00);

        // outline from the mask
        this.texel = uniform(new THREE.Vector2(1, 1));
        this.width = uniform(2);
        const mask = texture(this.maskTarget.texture);
        const selectColor = vec3(0.22, 0.74, 0.97);   // sky-400
        const hoverColor = vec3(1.0, 0.67, 0.2);      // amber
        const outline = Fn(() => {
            const center = mask.sample(screenUV);
            const d = this.texel.mul(this.width);
            let neighbors = mask.sample(screenUV.add(vec2(d.x, 0)));
            for (const [x, y] of [[-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
                neighbors = max(neighbors, mask.sample(screenUV.add(vec2(d.x.mul(x), d.y.mul(y)))));
            }
            const sel = clamp(neighbors.r.sub(center.r), 0, 1);
            const hov = clamp(neighbors.g.sub(center.g), 0, 1);
            // subtle fill on mouse-over
            const hovFill = center.g.mul(0.12);
            const alpha = max(max(sel, hov), hovFill);
            const color = mix(selectColor, hoverColor, max(hov, hovFill).div(alpha.max(float(1e-4))).clamp(0, 1));
            return vec4(color, alpha);
        })();
        this.overlayMaterial = new THREE.NodeMaterial();
        this.overlayMaterial.fragmentNode = outline;
        this.overlayMaterial.transparent = true;
        this.overlayMaterial.depthTest = false;
        this.overlayMaterial.depthWrite = false;
        this.overlayMaterial.toneMapped = false;
        this.quad = new THREE.QuadMesh(this.overlayMaterial);
        this._size = new THREE.Vector2();
    }

    /** Set the objects to highlight (groups are resolved to their meshes) */
    set(selectedObject, hoveredObject) {
        this.selected = collectMeshes(selectedObject);
        this.hovered = hoveredObject === selectedObject ? [] : collectMeshes(hoveredObject);
    }

    get active() {
        return this.selected.length > 0 || this.hovered.length > 0;
    }

    /** Call after the actual image (raster or path tracer) */
    render() {
        if (!this.active) return;
        const { renderer, scene, camera } = this;

        renderer.getDrawingBufferSize(this._size);
        if (this.maskTarget.width !== this._size.x || this.maskTarget.height !== this._size.y) {
            this.maskTarget.setSize(this._size.x, this._size.y);
        }
        this.texel.value.set(1 / this._size.x, 1 / this._size.y);
        this.width.value = Math.max(1, Math.round(renderer.getPixelRatio() * 1.5));

        const prev = {
            target: renderer.getRenderTarget(),
            autoClear: renderer.autoClear,
            background: scene.background,
            backgroundNode: scene.backgroundNode,
            override: scene.overrideMaterial,
            mask: camera.layers.mask,
            clearAlpha: renderer.getClearAlpha(),
        };
        const clearColor = renderer.getClearColor(new THREE.Color());

        // mask pass: only the highlighted meshes (dedicated layer)
        renderer.setRenderTarget(this.maskTarget);
        renderer.setClearColor(0x000000, 0);
        // also the node background (HDRI dome) – otherwise it would be drawn into the mask
        scene.background = null;
        scene.backgroundNode = null;
        camera.layers.set(LAYER);
        renderer.clear();
        renderer.autoClear = false;
        const drawMask = cam => {
            renderer.clear();
            for (const [meshes, material] of [[this.selected, this.selectedMaterial], [this.hovered, this.hoveredMaterial]]) {
                if (!meshes.length) continue;
                meshes.forEach(m => m.layers.enable(LAYER));
                scene.overrideMaterial = material;
                renderer.render(scene, cam);
                meshes.forEach(m => m.layers.disable(LAYER));
            }
        };
        // fisheye: mask through the cube map into the mask target (outline then in screen space as usual)
        if (this.fisheye?.active) this.fisheye.render(renderer, camera, drawMask);
        else drawMask(camera);

        // outline over the image
        camera.layers.mask = prev.mask;
        scene.overrideMaterial = prev.override;
        scene.background = prev.background;
        scene.backgroundNode = prev.backgroundNode;
        renderer.setClearColor(clearColor, prev.clearAlpha);
        renderer.setRenderTarget(prev.target);
        this.quad.render(renderer);
        renderer.autoClear = prev.autoClear;
    }
}

// Meshes below an object, visible ones only
function collectMeshes(object) {
    const out = [];
    if (!object) return out;
    // multi-selection (scene-graph selectMeshes): only the visible ones of the selected meshes
    if (object.isMeshSet) return object.members.flatMap(collectMeshes);
    for (let o = object; o; o = o.parent) if (!o.visible) return out;
    object.traverseVisible(c => { if (c.isMesh && !c.isSplat) out.push(c); });   // splats: no outline (their quads would be drawn)
    return out;
}
