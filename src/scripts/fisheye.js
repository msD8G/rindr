// Field of view beyond perspective: the camera panel's "field of view" goes up to MAX_VIEW_ANGLE; above
// PERSPECTIVE_LIMIT the picture continues as a fisheye (no jump at the limit). Lens family r = k·tan(θ/k)
// (k = 1 rectilinear, k = 2 stereographic fisheye, larger → towards equidistant): with H = half the vertical
// view angle and k = H / (PERSPECTIVE_LIMIT / 2), the angle from the axis at screen radius ρ (half image
// height = 1) is θ = k·atan(ρ·tan(PERSPECTIVE_LIMIT / 2)) – at the upper edge exactly H, at k = 1 the
// normal perspective. camera.fov (three.js projection, raster, fitting) stays ≤ PERSPECTIVE_LIMIT, the full
// value lives in camera.userData.viewAngle (viewAngle()/setViewAngle()).
// Path tracer: the camera rays get the fisheye direction (Vite plugin in astro.config.mjs patches
// three-gpu-pathtracer's PhysicalCamera; depth of field then uses a spherical focus surface around the camera).
// Raster views (Basic/Default, HQ while paused or animating) like drei's <Fisheye>
// (https://drei.docs.pmnd.rs/portals/fisheye): RasterFisheye renders the scene into a cube map from the camera
// position and draws it full-screen with the same mapping.
import * as THREE from 'three/webgpu';
import { uniform, cubeTexture, screenUV, vec2, vec3, vec4, float, Fn } from 'three/tsl';
import { wgslTagFn, rayStruct } from 'three-mesh-bvh/webgpu';

export const PERSPECTIVE_LIMIT = 100;   // ° vertical – above: fisheye
export const MAX_VIEW_ANGLE = 240;

const TAN_LIMIT = Math.tan(PERSPECTIVE_LIMIT * Math.PI / 360);
const U = {
    k: uniform(1),
    aspect: uniform(1),
};

/** Full vertical view angle (°) of the camera incl. the fisheye part */
export function viewAngle(camera) {
    return camera.userData.viewAngle ?? camera.fov;
}

/** Set the view angle: up to PERSPECTIVE_LIMIT the normal perspective, above that fisheye */
export function setViewAngle(camera, angle) {
    const a = Math.min(Math.max(angle, 1), MAX_VIEW_ANGLE);
    camera.fov = Math.min(a, PERSPECTIVE_LIMIT);
    if (a > PERSPECTIVE_LIMIT) camera.userData.viewAngle = a;
    else delete camera.userData.viewAngle;
    camera.updateProjectionMatrix();
}

export function fisheyeEnabled() {
    return U.k.value > 1;
}

/** Camera-space direction (−Z forward) of the fisheye at an NDC point – same formula as the shaders */
export function fisheyeLocalDirection(ndcX, ndcY, out = new THREE.Vector3()) {
    const qx = ndcX * U.aspect.value, qy = ndcY;
    const len = Math.hypot(qx, qy);
    const theta = Math.min(U.k.value * Math.atan(len * TAN_LIMIT), Math.PI);
    const f = len > 1e-6 ? Math.sin(theta) / len : 0;
    return out.set(qx * f, qy * f, -Math.cos(theta));
}

/** Inverse of fisheyeLocalDirection: NDC of a camera-space direction (null if outside the fisheye's reach) */
export function fisheyeProject(local, out = new THREE.Vector2()) {
    const len = Math.hypot(local.x, local.y);
    const half = Math.atan2(len, -local.z) / U.k.value;
    if (half >= Math.PI / 2 - 1e-3) return null;
    const rho = Math.tan(half) / TAN_LIMIT;
    return len > 1e-9 ? out.set(local.x / len * rho / U.aspect.value, local.y / len * rho) : out.set(0, 0);
}

/** Raycaster.setFromCamera for the fisheye (ray from the camera position) – falls back to the normal one */
export function patchRaycaster(raycaster) {
    const original = raycaster.setFromCamera.bind(raycaster);
    raycaster.setFromCamera = (coords, camera) => {
        if (!fisheyeEnabled() || !camera.isPerspectiveCamera) return original(coords, camera);
        raycaster.camera = camera;
        raycaster.ray.origin.setFromMatrixPosition(camera.matrixWorld);
        fisheyeLocalDirection(coords.x, coords.y, raycaster.ray.direction).transformDirection(camera.matrixWorld);
    };
    return raycaster;
}

/** Take over the camera's view angle and aspect (every frame); true if changed */
export function setFisheye(camera) {
    const k = Math.max(1, viewAngle(camera) / PERSPECTIVE_LIMIT);
    if (U.k.value === k && U.aspect.value === camera.aspect) return false;
    U.k.value = k;
    U.aspect.value = camera.aspect;
    return true;
}

/** TSL: camera-space fisheye direction (−Z forward) at an NDC point – same formula as fisheyeLocalDirection */
export function fisheyeDirectionNode(ndc) {
    const q = vec2(ndc.x.mul(U.aspect), ndc.y);
    const len = q.length();
    const theta = U.k.mul(len.mul(TAN_LIMIT).atan()).min(Math.PI);
    const side = q.div(len.max(1e-6));
    return vec3(side.mul(theta.sin()), theta.cos().negate());
}

/** TSL: fisheye on (k > 1 – the view angle is above PERSPECTIVE_LIMIT) */
export const fisheyeOnNode = () => U.k.greaterThan(1);

// ray: three-mesh-bvh ray struct – set to the fisheye ray from the camera origin when enabled (returns true).
// The return type is required: three.js' WGSL parser rejects functions without one.
export const FISHEYE_RAY = wgslTagFn/* wgsl */`
    fn fisheyeRay( ndc: vec2f, cameraWorld: mat4x4f, ray: ptr<function, ${ rayStruct }> ) -> bool {

        if ( ${ U.k } <= 1.0 ) {

            return false;

        }

        let q = vec2f( ndc.x * ${ U.aspect }, ndc.y );
        let len = length( q );
        let theta = min( ${ U.k } * atan( len * ${ TAN_LIMIT } ), 3.14159265 );
        let side = select( vec2f( 0.0 ), q / len, len > 1e-6 );
        let local = vec3f( side * sin( theta ), - cos( theta ) );

        ray.origin = ( cameraWorld * vec4f( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        ray.direction = normalize( ( cameraWorld * vec4f( local, 0.0 ) ).xyz );
        return true;

    }
`;

// Raster fisheye like drei <Fisheye>: six 90° views into a cube render target, then a full-screen quad looks up
// each pixel's fisheye direction. render(…, draw) calls draw(faceCamera) per cube face (scene, section caps,
// contact shadow, highlight mask, gizmo – everything that is drawn with the camera).
export class RasterFisheye {
    constructor() {
        this.target = this._createTarget(16);
        this.cubeCamera = new THREE.CubeCamera(0.1, 1000, this.target);
        this.rotation = uniform(new THREE.Matrix4());
        this.envNode = cubeTexture(this.target.texture);
        const color = Fn(() => {
            const ndc = vec2(screenUV.x.mul(2).sub(1), screenUV.y.mul(-2).add(1));
            const dir = this.rotation.mul(vec4(fisheyeDirectionNode(ndc), 0)).xyz;
            return this.envNode.sample(dir);
        })();
        const material = (blending, opacity) => {
            const m = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
            m.colorNode = color.rgb;
            m.opacityNode = opacity;
            m.blending = blending;
            return m;
        };
        // the image itself is opaque (the cube's background alpha is not 1 – the lens effects target used it)
        this.quad = new THREE.QuadMesh(material(THREE.NoBlending, float(1)));
        // overlays (gizmo): premultiplied colour over the image
        this.overlayQuad = new THREE.QuadMesh(material(THREE.NormalBlending, color.a));
        this.overlayQuad.material.premultipliedAlpha = true;
        this.overlayQuad.material.transparent = true;   // otherwise three.js writes alpha 1 (opaque + normal blending)
        this.overlayQuad.material.toneMapped = false;
        this._size = new THREE.Vector2();
    }

    _createTarget(size) {
        return new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true });
    }

    get active() {
        return fisheyeEnabled();
    }

    // cube resolution: centre pixel density of the fisheye ≈ that of a cube face
    _resize(renderer) {
        renderer.getDrawingBufferSize(this._size);
        // centre: dθ/dpixel = k·tan(limit/2) / (half height in pixels); a face has 90° over its width
        const perPixel = U.k.value * TAN_LIMIT / (this._size.y / 2);
        const size = Math.min(2048, Math.max(256, Math.ceil(Math.PI / 2 / perPixel / 64) * 64));
        // new target: setSize() does not resize the GPU texture of a CubeRenderTarget (stays at the old size)
        if (this.target.width !== size) {
            this.target.dispose();
            this.target = this._createTarget(size);
            this.cubeCamera.renderTarget = this.target;
            this.envNode.value = this.target.texture;
        }
    }

    /**
     * draw(faceCamera) for each cube face (the render target is set), then the fisheye image into the render
     * target that was current before. overlay: blend over it (transparent clear) instead of replacing it.
     * shadowLights: their shadow maps are rendered only for the first face (they do not depend on the camera).
     */
    render(renderer, camera, draw, { overlay = false, shadowLights = [] } = {}) {
        this._resize(renderer);
        const { cubeCamera, target } = this;
        if (cubeCamera.coordinateSystem !== renderer.coordinateSystem) {
            cubeCamera.coordinateSystem = renderer.coordinateSystem;
            cubeCamera.updateCoordinateSystem();
        }
        camera.updateMatrixWorld();
        cubeCamera.position.setFromMatrixPosition(camera.matrixWorld);
        cubeCamera.updateMatrixWorld(true);
        for (const face of cubeCamera.children) {
            if (face.near !== camera.near || face.far !== camera.far) {
                face.near = camera.near;
                face.far = camera.far;
                face.updateProjectionMatrix();
            }
            face.layers.mask = camera.layers.mask;
        }
        const prev = {
            target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
            clearColor: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha(), autoClear: renderer.autoClear,
        };
        const shadows = shadowLights.filter(l => l.castShadow && l.shadow?.autoUpdate);
        // overlay: transparent faces (the clear of render() with autoClear did not keep alpha 0)
        if (overlay) {
            renderer.setClearColor(0x000000, 0);
            renderer.autoClear = false;
        }
        cubeCamera.children.forEach((face, i) => {
            if (i === 1) shadows.forEach(l => { l.shadow.autoUpdate = false; });
            renderer.setRenderTarget(target, i);
            if (overlay) renderer.clear();
            draw(face);
        });
        shadows.forEach(l => { l.shadow.autoUpdate = true; });
        if (overlay) renderer.setClearColor(prev.clearColor, prev.clearAlpha);
        renderer.setRenderTarget(prev.target, prev.face, prev.mip);
        this.rotation.value.extractRotation(camera.matrixWorld);
        // the overlay quad must not clear the image below (QuadMesh.render clears with autoClear)
        (overlay ? this.overlayQuad : this.quad).render(renderer);
        renderer.autoClear = prev.autoClear;
    }
}
