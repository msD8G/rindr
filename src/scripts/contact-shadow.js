// Contact shadow for the raster preview (like three.js' "contact shadows" example): where the model
// touches or nearly touches the ground it gets a soft dark area – without it the model seems to float,
// the shadow maps of the lights are offset and hard. The path tracer does not need it (its shadow
// catcher shades the ground physically), so it is drawn as an overlay after the raster image only.
//
// 1. orthographic camera on the ground looking up renders the model: alpha = 1 − (height above ground
//    / fade height) – the depth test keeps the surface closest to the ground (= darkest)
// 2. blurred twice (separable, horizontal + vertical)
// 3. a plane on the ground shows it (depth test against the raster image, so the model covers it)
// Only re-rendered when something changed (markDirty: model, transforms, visibility).
import * as THREE from 'three/webgpu';
import { Fn, float, positionWorld, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

const SIZE = 512;
const _meshBox = new THREE.Box3();
const BLUR_TAPS = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(i => [i, Math.exp(-(i * i) / 8)]);
const BLUR_SUM = BLUR_TAPS.reduce((s, [, w]) => s + w, 0);

export class ContactShadow {
    constructor() {
        this.strength = 0.65;
        this.dirty = true;
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.camera.up.set(0, 0, 1);
        const rt = () => new THREE.RenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType });
        this.target = rt();
        this.blurA = rt();
        this.blurB = rt();

        // 1. height above the ground → darkness
        this._ground = uniform(0);
        this._fade = uniform(1);
        this.depthMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
        this.depthMaterial.colorNode = vec4(0, 0, 0, 1);
        this.depthMaterial.outputNode = vec4(0, 0, 0, float(1).sub(positionWorld.y.sub(this._ground).div(this._fade)).clamp(0, 1).pow(2));

        // 2. separable blur
        this._blurSource = texture(this.target.texture);
        this._blurDir = uniform(new THREE.Vector2());
        this.blurMaterial = new THREE.NodeMaterial();
        this.blurMaterial.fragmentNode = Fn(() => {
            let a = float(0);
            for (const [i, w] of BLUR_TAPS) a = a.add(this._blurSource.sample(uv().add(this._blurDir.mul(i))).a.mul(w / BLUR_SUM));
            return vec4(0, 0, 0, a);
        })();
        this.quad = new THREE.QuadMesh(this.blurMaterial);

        // 3. plane on the ground, uv from the world position (same mapping as the camera)
        this._rect = uniform(new THREE.Vector4(0, 0, 1, 1));   // min x, min z, width, depth
        this._strength = uniform(this.strength);
        this._shadowTex = texture(this.blurB.texture);
        // the camera (up = +z) puts the largest z in the first row of the render target – WebGPU textures start
        // at the top row, hence v runs from max z to min z
        const planeUv = vec2(positionWorld.x.sub(this._rect.x).div(this._rect.z), float(1).sub(positionWorld.z.sub(this._rect.y).div(this._rect.w)));
        this.planeMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        this.planeMaterial.colorNode = vec4(0, 0, 0, 1);
        this.planeMaterial.opacityNode = this._shadowTex.sample(planeUv).a.mul(this._strength);
        this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.planeMaterial);
        this.plane.frustumCulled = false;
        this.overlay = new THREE.Scene();
        this.overlay.add(this.plane);
        this._box = new THREE.Box3();
    }

    markDirty() {
        this.dirty = true;
    }

    /** Update the shadow map if needed (model root, ground height) */
    update(renderer, scene, root, groundY, hide = []) {
        if (!this.dirty || !root) return;
        this.dirty = false;
        root.updateMatrixWorld(true);
        // footprint of the model without stray objects (outliers.js – kilometres of helper geometry would spread the
        // shadow map over nothing)
        const box = this._box.makeEmpty();
        root.traverse(c => {
            if (!c.isMesh || c.userData.stray) return;
            if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
            box.union(_meshBox.copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld));
        });
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const fade = Math.max(size.x, size.y, size.z) * 0.25;
        // footprint + margin for the blur
        const margin = Math.max(size.x, size.z) * 0.15 + fade;
        const minX = box.min.x - margin, minZ = box.min.z - margin;
        const w = size.x + 2 * margin, d = size.z + 2 * margin;
        const cam = this.camera;
        cam.left = -w / 2; cam.right = w / 2; cam.top = d / 2; cam.bottom = -d / 2;
        cam.near = 0; cam.far = fade;
        cam.position.set(minX + w / 2, groundY, minZ + d / 2);
        cam.lookAt(cam.position.x, groundY + 1, cam.position.z);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        this._ground.value = groundY;
        this._fade.value = fade;
        this._rect.value.set(minX, minZ, w, d);
        this.plane.position.set(minX + w / 2, groundY, minZ + d / 2);
        this.plane.scale.set(w, 1, d);
        this.plane.updateMatrixWorld();

        // render the model from below
        const prev = {
            background: scene.background, backgroundNode: scene.backgroundNode, override: scene.overrideMaterial,
            target: renderer.getRenderTarget(), autoClear: renderer.autoClear, clearAlpha: renderer.getClearAlpha(),
            clearColor: renderer.getClearColor(new THREE.Color()), visible: hide.map(o => o.visible),
        };
        hide.forEach(o => { o.visible = false; });
        scene.background = null;
        scene.backgroundNode = null;
        scene.overrideMaterial = this.depthMaterial;
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.setRenderTarget(this.target);
        renderer.render(scene, cam);
        // blur: target → A (horizontal) → B (vertical), twice as wide in the second round
        const pass = (source, dest, dx, dy) => {
            this._blurSource.value = source.texture;
            this._blurDir.value.set(dx / SIZE, dy / SIZE);
            renderer.setRenderTarget(dest);
            this.quad.render(renderer);
        };
        pass(this.target, this.blurA, 1.5, 0);
        pass(this.blurA, this.blurB, 0, 1.5);
        pass(this.blurB, this.blurA, 3, 0);
        pass(this.blurA, this.blurB, 0, 3);
        renderer.setRenderTarget(prev.target);
        renderer.setClearColor(prev.clearColor, prev.clearAlpha);
        renderer.autoClear = prev.autoClear;
        scene.overrideMaterial = prev.override;
        scene.background = prev.background;
        scene.backgroundNode = prev.backgroundNode;
        hide.forEach((o, i) => { o.visible = prev.visible[i]; });
    }

    /** Draw the shadow over the raster image (uses its depth buffer) */
    render(renderer, camera) {
        this._strength.value = this.strength;
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.render(this.overlay, camera);
        renderer.autoClear = autoClear;
    }
}
