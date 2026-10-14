// Depth of field for the path tracer + display of the focus plane in the raster preview.
//
// The camera is a PhysicalCamera from three-gpu-pathtracer: its rays start on an aperture
// and meet in the focus plane (flat, perpendicular to the view direction, at distance
// focusDistance). The shader computes the aperture in metres (bokehSize in mm · 1e-3), but the scene
// is in mm – hence fStop / 1000: this way "aperture" matches the real f-number at the current
// focal length (35 mm format, derived from the field of view). Off = aperture 0 (pinhole camera).
//
// Focus line (raster preview, not in the path traced image): where the focus plane cuts the surfaces.
// After the raster image the scene is drawn once more with an override material (same depth, LessEqual +
// polygon offset) that is green where the pixel's distance along the view direction equals the focus
// distance; the width comes from the screen-space derivative (fwidth) → about 2 px at any distance.
// A surface facing the camera exactly at the focus distance turns green as a whole (it is all sharp).
// Previously a semi-transparent plane tinted everything behind it – but what is in front is just as
// blurred, that looked odd.
// Fisheye (raster preview = 6 cube faces, fisheye.js): the line is drawn into every face right after the
// scene (that is where the depth buffer is) and then goes through the same mapping as the image; the focus
// there is a sphere around the camera (like the path tracer's fisheye rays) → distance = length of the
// view-space position instead of the depth along the view direction.
import * as THREE from 'three/webgpu';
import { float, fwidth, length, max, mix, positionView, smoothstep, uniform, vec3 } from 'three/tsl';

const _dir = new THREE.Vector3();

export class DepthOfField {
    constructor(camera) {
        this.camera = camera;
        this.enabled = false;
        this.fStop = 2.8;            // f-number
        this.focusDistance = 1000;   // mm along the view direction
        this.blades = 0;             // aperture blades, 0 = round
        this.autoFocus = false;      // focus plane follows the orbit pivot
        this.showPlane = true;       // show the focus line in the preview (while the camera is selected)
        this.focusSet = false;       // focus already set once (otherwise set to the pivot when enabling)

        this._focus = uniform(1000);
        this._sphere = uniform(0);   // 1 = fisheye: distance to the camera
        // distance along the view direction (like focusDistance), in the fisheye to the camera
        const depth = mix(positionView.z.negate(), length(positionView), this._sphere);
        const pixels = depth.sub(this._focus).abs().div(max(fwidth(depth), 1e-6));
        this.lineMaterial = new THREE.MeshBasicNodeMaterial({
            transparent: true, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide,
        });
        this.lineMaterial.colorNode = vec3(0.25, 0.95, 0.4);
        this.lineMaterial.opacityNode = float(1).sub(smoothstep(1.25, 2.25, pixels));
        this.apply();
    }

    /** Transfer the values to the camera (then call pathTracing.updateCamera()) */
    apply() {
        const c = this.camera;
        c.fStop = this.enabled ? Math.max(this.fStop, 0.1) / 1000 : Infinity;
        c.focusDistance = Math.max(this.focusDistance, 1e-3);
        c.apertureBlades = this.blades;
    }

    /** Distance of a world point to the camera along the view direction */
    depthOf(point) {
        this.camera.getWorldDirection(_dir);
        return Math.max(point.clone().sub(this.camera.position).dot(_dir), 1e-3);
    }

    /**
     * Draw the focus line into the preview (right after the raster image – needs its depth buffer).
     * Everything visible gets the line material (also the ground; hidden objects stay hidden).
     * @param {THREE.Material[]} include  materials with allowOverride = false that should get the line too
     * @param {THREE.Camera} camera  fisheye: the cube face camera (focus = sphere around the camera)
     */
    renderLine(renderer, scene, include = [], camera = null) {
        this._focus.value = this.focusDistance;
        this._sphere.value = camera ? 1 : 0;
        const prev = {
            background: scene.background, backgroundNode: scene.backgroundNode, override: scene.overrideMaterial,
            autoClear: renderer.autoClear, allow: include.map(m => m.allowOverride),
        };
        // Gaussian splats keep their own material (allowOverride = false) – they would be drawn a second time
        const splats = [];
        scene.traverseVisible(o => { if (o.isSplat) splats.push(o); });
        splats.forEach(o => { o.visible = false; });
        scene.background = null;
        scene.backgroundNode = null;
        scene.overrideMaterial = this.lineMaterial;
        include.forEach(m => { m.allowOverride = true; });
        renderer.autoClear = false;
        renderer.render(scene, camera || this.camera);
        renderer.autoClear = prev.autoClear;
        splats.forEach(o => { o.visible = true; });
        include.forEach((m, i) => { m.allowOverride = prev.allow[i]; });
        scene.overrideMaterial = prev.override;
        scene.background = prev.background;
        scene.backgroundNode = prev.backgroundNode;
    }

    toJSON() {
        const { enabled, fStop, focusDistance, blades, autoFocus } = this;
        return { enabled, fStop, focusDistance: +focusDistance.toFixed(3), blades, autoFocus };
    }

    fromJSON(s) {
        if (!s) return;
        this.enabled = !!s.enabled;
        if (s.fStop != null) this.fStop = s.fStop;
        if (s.focusDistance != null) { this.focusDistance = s.focusDistance; this.focusSet = true; }
        if (s.blades != null) this.blades = s.blades;
        this.autoFocus = !!s.autoFocus;
        this.apply();
    }
}
