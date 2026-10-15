// View cube (like Blender/CAD): floats in a corner, turns with the camera; faces, edges and corners can be
// clicked – the camera flies to that view (viewer.js: flyToDirection). Dragging on the cube orbits.
//
// Plain CSS 3D (divs with matrix3d, preserve-3d) instead of a second WebGPU view: always sharp, no extra render
// pass, does not touch the raster/path tracing pipeline; the browser hit-tests the 3D faces itself.
// Every face is a 3×3 grid: centre = the face's view, sides = edge views, corners = corner views – 26 directions,
// cells with the same direction (an edge appears on two faces, a corner on three) highlight together.
import * as THREE from 'three/webgpu';
import { t } from './i18n.js';

const SIZE = 64;   // edge length of the cube in CSS pixels

// faces in world coordinates (Y up, front = +Z like three.js' default camera): normal, right and up on the face
const FACES = [
    { key: 'front', n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { key: 'back', n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { key: 'right', n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { key: 'left', n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { key: 'top', n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },     // read from the front
    { key: 'bottom', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
];
// name of the face pointing along an axis direction (tooltips of edges/corners)
const AXIS_NAMES = { '1,0,0': 'right', '-1,0,0': 'left', '0,1,0': 'top', '0,-1,0': 'bottom', '0,0,1': 'front', '0,0,-1': 'back' };

// CSS space = world with Y flipped (CSS y points down)
const css = ([x, y, z]) => [x, -y, z];

// Chrome hit-testing fails for the whole cube at some exactly axis-aligned orientations (right view: every click
// fell through to the background, left worked thanks to a rounding residue). An invisible tilt (~0.06°) keeps the
// faces from ever being exactly perpendicular to the view.
const TILT = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 2, 3).normalize(), 1e-3);
const _view = new THREE.Matrix4();

export class ViewCube {
    /**
     * @param {HTMLElement} root
     * @param {{ onSelect: (dir: THREE.Vector3) => void, onOrbit: (dx: number, dy: number) => void,
     *           onOrbitStart?: () => void, onOrbitEnd?: () => void }} handlers
     */
    constructor(root, handlers) {
        this.root = root;
        this.handlers = handlers;
        this._key = '';
        this._pointer = null;     // last pointer position over the cube
        this._hovered = null;
        root.className = 'pointer-events-auto absolute right-5 bottom-5 flex size-28 cursor-pointer touch-none items-center justify-center select-none';
        root.title = t('viewCube.title');
        this.cube = document.createElement('div');
        this.cube.style.cssText = 'position:relative;width:0;height:0;transform-style:preserve-3d;';
        root.append(this.cube);
        this.cells = new Map();   // direction key -> cells

        for (const face of FACES) {
            const el = document.createElement('div');
            el.className = 'absolute grid overflow-hidden rounded-[3px] bg-black/60 text-white/90 ring-1 ring-white/25 backdrop-blur-sm';
            el.style.cssText += `width:${SIZE}px;height:${SIZE}px;left:${-SIZE / 2}px;top:${-SIZE / 2}px;`
                + 'grid-template-columns:22% 56% 22%;grid-template-rows:22% 56% 22%;backface-visibility:hidden;'
                + `transform:${faceMatrix(face)};`;
            // rows from the top of the face (v = +1) down, columns from the left (u = -1)
            for (const j of [1, 0, -1]) {
                for (const i of [-1, 0, 1]) {
                    const dir = new THREE.Vector3(...face.n)
                        .addScaledVector(new THREE.Vector3(...face.u), i)
                        .addScaledVector(new THREE.Vector3(...face.v), j);
                    const key = dir.toArray().join(',');
                    const cell = document.createElement('div');
                    cell.className = 'flex items-center justify-center transition-colors duration-100';
                    cell.dataset.dir = key;
                    if (i === 0 && j === 0) {
                        cell.textContent = t(`viewCube.${face.key}`);
                        cell.className += ' text-[9px] leading-none font-medium uppercase tracking-wide';
                    }
                    cell.title = dirLabel(dir);
                    if (!this.cells.has(key)) this.cells.set(key, []);
                    this.cells.get(key).push(cell);
                    el.append(cell);
                }
            }
            this.cube.append(el);
        }
        this._setupPointer();
    }

    // hover: the cell under the pointer – also re-checked when the cube turns under a resting pointer (after a
    // click it flies away; per-cell enter/leave events left the old cell highlighted)
    _hover() {
        const p = this._pointer;
        const el = p && document.elementFromPoint(p.x, p.y)?.closest('[data-dir]');
        this._highlight(el && this.root.contains(el) ? el.dataset.dir : null);
    }

    _highlight(key) {
        if (key === this._hovered) return;
        this._hovered = key;
        for (const [k, cells] of this.cells) {
            for (const c of cells) c.classList.toggle('bg-sky-500/60', k === key);
        }
    }

    // click = view of the cell under the pointer; drag (> 4 px) = orbit
    _setupPointer() {
        let start = null;
        this.root.addEventListener('pointermove', e => { this._pointer = { x: e.clientX, y: e.clientY }; this._hover(); });
        this.root.addEventListener('pointerleave', () => { this._pointer = null; this._hover(); });
        this.root.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            start = { x: e.clientX, y: e.clientY, last: [e.clientX, e.clientY], dragging: false, cell: e.target.closest('[data-dir]') };
            this.root.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        this.root.addEventListener('pointermove', e => {
            if (!start) return;
            if (!start.dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) {
                start.dragging = true;
                this.handlers.onOrbitStart?.();
            }
            if (start.dragging) {
                this.handlers.onOrbit(e.clientX - start.last[0], e.clientY - start.last[1]);
                start.last = [e.clientX, e.clientY];
            }
        });
        const end = () => {
            if (!start) return;
            if (start.dragging) this.handlers.onOrbitEnd?.();
            else if (start.cell) this.handlers.onSelect(new THREE.Vector3(...start.cell.dataset.dir.split(',').map(Number)).normalize());
            start = null;
        };
        this.root.addEventListener('pointerup', end);
        this.root.addEventListener('pointercancel', () => { if (start?.dragging) this.handlers.onOrbitEnd?.(); start = null; });
    }

    /** Turn the cube like the world seen by `camera` (call per frame; cheap when nothing changed) */
    update(camera) {
        camera.updateMatrixWorld();
        const e = _view.multiplyMatrices(camera.matrixWorldInverse, TILT).elements;   // column-major, upper 3×3 = world → view rotation
        const key = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]].map(v => v.toFixed(4)).join();
        if (key === this._key) return;
        this._key = key;
        // CSS = F · R · F with F = diag(1, -1, 1) (view: y up, CSS: y down; both z towards the viewer)
        const m = [
            e[0], -e[1], e[2], 0,
            -e[4], e[5], -e[6], 0,
            e[8], -e[9], e[10], 0,
            0, 0, 0, 1,
        ];
        this.cube.style.transform = `matrix3d(${m.join(',')})`;
        if (this._pointer) this._hover();
    }
}

// face element: CSS x → u, CSS y (down) → −v, z → normal, moved out by half the edge
function faceMatrix({ n, u, v }) {
    const [ux, uy, uz] = css(u), [vx, vy, vz] = css(v.map(c => -c)), [nx, ny, nz] = css(n);
    const h = SIZE / 2;
    return `matrix3d(${[ux, uy, uz, 0, vx, vy, vz, 0, nx, ny, nz, 0, nx * h, ny * h, nz * h, 1].join(',')})`;
}

// tooltip: "Oben", "Oben · Vorne", "Oben · Vorne · Rechts"
function dirLabel(dir) {
    const parts = [];
    for (const axis of [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]]) {
        if (axis[0] * dir.x + axis[1] * dir.y + axis[2] * dir.z > 0.5) parts.push(t(`viewCube.${AXIS_NAMES[axis.join(',')]}`));
    }
    return parts.join(' · ');
}
