// Section plane (slicer): cuts the model open at a freely movable and rotatable plane.
//
// The model hangs in a ClippingGroup (WebGPU clipping, applies to all meshes inside – also
// to shadows, picking mask and highlight). The plane is an Object3D: position = point
// on the plane, local Z axis = normal; the side the normal points to is cut away.
//
// Cut surfaces ("caps", closed like a cut solid): stencil technique after the normal image –
//   1. the clipped model is drawn invisibly into the stencil buffer (no colour, no depth, no depth test):
//      back faces +1, front faces −1. Where the plane lies inside a solid, more back than front faces
//      remain behind the cut → stencil ≠ 0.
//   2. a plane exactly in the section plane is drawn only there (depth test against the image – parts in
//      front of it hide it), in the cap colour. So you look onto a closed, flat cut surface instead of into
//      the solid (previously only its inner back faces were coloured).
// Needs a stencil buffer (renderer stencil: true, lens effects target stencilBuffer: true). Only closed
// bodies take part in the stencil count (`isClosed`, set by the viewer: STEP solids yes / surface models no,
// other meshes checked with isClosedGeometry) – open meshes (sheet metal, the DamagedHelmet) would leave
// the count uneven and the cap would cover what lies behind the cut. They stay open.
//
// The path tracer knows no clipping – with an active section only rasterisation is used.
import * as THREE from 'three/webgpu';

const _n = new THREE.Vector3();

/**
 * Is the mesh a closed body? Every edge must belong to exactly two triangles (vertices welded by position –
 * glTF splits them at uv/normal seams); up to 0.2 % open edges are tolerated (tiny gaps). Cached per geometry.
 */
export function isClosedGeometry(geometry) {
    if (geometry.userData.closed !== undefined) return geometry.userData.closed;
    const pos = geometry.getAttribute('position'), index = geometry.index;
    let closed = false;
    if (pos && pos.count <= 4e6) {
        const n = pos.count, id = new Int32Array(n), weld = new Map();
        for (let i = 0; i < n; i++) {
            const key = `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
            let v = weld.get(key);
            if (v === undefined) weld.set(key, v = weld.size);
            id[i] = v;
        }
        const m = weld.size, edges = new Map();
        const tri = index ? index.count : n;
        const at = i => id[index ? index.getX(i) : i];
        for (let t = 0; t < tri; t += 3) {
            for (let k = 0; k < 3; k++) {
                const a = at(t + k), b = at(t + (k + 1) % 3);
                if (a === b) continue;
                const key = a < b ? a * m + b : b * m + a;
                edges.set(key, (edges.get(key) || 0) + 1);
            }
        }
        let open = 0;
        for (const c of edges.values()) if (c === 1) open++;
        closed = edges.size > 0 && open <= edges.size * 0.002;
    }
    geometry.userData.closed = closed;
    return closed;
}
const _p = new THREE.Vector3();

export class Slicer {
    constructor() {
        this.group = new THREE.ClippingGroup();
        this.group.name = 'Section';
        this.group.enabled = false;
        this.group.clipShadows = true;
        this.plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
        this.group.clippingPlanes = [this.plane];

        // plane (gizmo target); initial position: through the model centre, cut along Z
        this.object = new THREE.Object3D();
        this.object.name = 'SectionPlane';
        this.flipped = false;

        // 1. stencil passes: count back faces up, front faces down
        const stencilPass = (side, op) => {
            const m = new THREE.MeshBasicNodeMaterial({ side, colorWrite: false, depthWrite: false, depthTest: false });
            Object.assign(m, {
                stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
                stencilFail: op, stencilZFail: op, stencilZPass: op,
            });
            return m;
        };
        this.stencilBack = stencilPass(THREE.BackSide, THREE.IncrementWrapStencilOp);
        this.stencilFront = stencilPass(THREE.FrontSide, THREE.DecrementWrapStencilOp);
        // 2. cap plane: only where the stencil ≠ 0 (resets it to 0 there)
        this.capMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xd04a3a, side: THREE.DoubleSide });
        this.capMaterial.toneMapped = false;
        Object.assign(this.capMaterial, {
            stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
            stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
        });
        this.capPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.capMaterial);
        this.capPlane.frustumCulled = false;
        this.capScene = new THREE.Scene();
        this.capScene.add(this.capPlane);

        // outline of the plane (for the gizmo's overlay scene)
        const frame = new THREE.BufferGeometry().setFromPoints([
            [-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1],
        ].map(([x, y]) => new THREE.Vector3(x, y, 0)));
        this.helper = new THREE.Group();
        this.helper.add(new THREE.Line(frame, new THREE.LineBasicNodeMaterial({ color: 0xff8a65, depthTest: false, transparent: true, opacity: 0.9 })));
        this.helper.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicNodeMaterial({
            color: 0xff8a65, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false, depthTest: false,
        })));
        this.helper.visible = false;
        this.size = 1;
        this.capExclude = [];     // objects outside the model that get no caps
        this.capRoot = () => null;   // model root (only its closed meshes are counted)
        this.isClosed = () => true;  // mesh → closed body?
        this.capBatches = () => [];  // InstancedMeshes drawing model meshes (outside capRoot)
    }

    get enabled() {
        return this.group.enabled;
    }

    set enabled(v) {
        this.group.enabled = v;
        this.update();
    }

    /** Extent of the model (for the size of the plane outline) */
    setModelSize(size) {
        this.size = size || 1;
        this.update();
    }

    /** Recompute the plane from the object's position/rotation */
    update() {
        const o = this.object;
        o.updateMatrixWorld(true);
        _n.set(0, 0, this.flipped ? -1 : 1).transformDirection(o.matrixWorld);
        o.getWorldPosition(_p);
        // clipping discards points with negative distance -> normal points to the visible side
        this.plane.setFromNormalAndCoplanarPoint(_n.negate(), _p);
        this.helper.position.copy(_p);
        o.getWorldQuaternion(this.helper.quaternion);
        this.helper.scale.setScalar(this.size * 0.6);
    }

    flip() {
        this.flipped = !this.flipped;
        this.update();
    }

    /** Is the point cut away? (for picking) */
    clips(point) {
        return this.enabled && this.plane.distanceToPoint(point) < 0;
    }

    /** Draw the closed cut surfaces after the raster image (same camera, depth buffer of the image) */
    renderCaps(renderer, scene, camera) {
        if (!this.enabled) return;
        const prev = {
            background: scene.background, backgroundNode: scene.backgroundNode, override: scene.overrideMaterial,
            autoClear: renderer.autoClear,
        };
        // only closed bodies of the model get caps (not the ground, not open meshes)
        const hidden = this.capExclude.filter(o => o.visible);
        this.capRoot()?.traverse(o => { if (o.isMesh && o.visible && !this.isClosed(o)) hidden.push(o); });
        for (const o of this.capBatches()) if (o.visible && !this.isClosed(o)) hidden.push(o);   // render-batcher.js
        hidden.forEach(o => { o.visible = false; });
        scene.background = null;
        scene.backgroundNode = null;
        renderer.autoClear = false;
        renderer.clearStencil();
        scene.overrideMaterial = this.stencilBack;
        renderer.render(scene, camera);
        scene.overrideMaterial = this.stencilFront;
        renderer.render(scene, camera);
        scene.overrideMaterial = prev.override;
        scene.background = prev.background;
        scene.backgroundNode = prev.backgroundNode;
        hidden.forEach(o => { o.visible = true; });
        // plane in the section plane, large enough for the model (its normal = local z)
        this.object.updateMatrixWorld(true);
        this.capPlane.position.copy(this.helper.position);
        this.capPlane.quaternion.copy(this.helper.quaternion);
        this.capPlane.scale.setScalar(this.size * 4);
        this.capPlane.updateMatrixWorld();
        renderer.render(this.capScene, camera);
        renderer.autoClear = prev.autoClear;
    }
}
