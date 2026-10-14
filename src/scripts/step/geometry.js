// Geometry kernel: curves and surfaces from STEP entities (AP203/AP214/AP242).
//
// Curves:   eval(t), d1(t), closest(P, guess), t0/t1 (domain), period
// Surfaces: evalD(u, v) -> {p, du, dv}, eval(u, v), normal(u, v), project(P, guess) -> [u, v],
//          uPeriod/vPeriod (0 = not periodic)
//
// All points are plain arrays [x, y, z].

import { Ref, partArgs, hasPart } from './parser.js';

const TAU = Math.PI * 2;

// --- Vector helpers ---
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
export const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
export function normalize(a) {
    const l = len(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
// a + b*s + c*t
const madd2 = (a, b, s, c, t) => [a[0] + b[0] * s + c[0] * t, a[1] + b[1] * s + c[1] * t, a[2] + b[2] * s + c[2] * t];

// Bring angle into [ref - π, ref + π)
export function wrapNear(a, ref, period) {
    return a - period * Math.round((a - ref) / period);
}

// --- Placements ---

export class Placement {
    constructor(o, x, y, z) { this.o = o; this.x = x; this.y = y; this.z = z; }
    // local coordinates -> world
    toWorld(a, b, c) {
        const { o, x, y, z } = this;
        return [o[0] + x[0] * a + y[0] * b + z[0] * c, o[1] + x[1] * a + y[1] * b + z[1] * c, o[2] + x[2] * a + y[2] * b + z[2] * c];
    }
    // world -> local coordinates
    toLocal(p) {
        const d = sub(p, this.o);
        return [dot(d, this.x), dot(d, this.y), dot(d, this.z)];
    }
    // 4x4 matrix (column-major like three.js)
    matrix() {
        const { o, x, y, z } = this;
        return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];
    }
}

export function makeFrame(o, zDir, xDir) {
    const z = normalize(zDir || [0, 0, 1]);
    let x = xDir ? sub(xDir, scale(z, dot(xDir, z))) : null;
    if (!x || len(x) < 1e-12) {
        // arbitrary perpendicular
        x = Math.abs(z[0]) < 0.9 ? cross([1, 0, 0], z) : cross([0, 1, 0], z);
        x = cross(z, x);
    }
    x = normalize(x);
    const y = cross(z, x);
    return new Placement(o, x, y, z);
}

// --- B-spline basics ---

function findSpan(n, p, u, U) {
    if (u >= U[n + 1]) {
        // last non-empty span
        let s = n;
        while (s > p && U[s] >= U[s + 1]) s--;
        return s;
    }
    if (u <= U[p]) {
        let s = p;
        while (s < n && U[s] >= U[s + 1]) s++;
        return s;
    }
    let lo = p, hi = n + 1, mid = (lo + hi) >> 1;
    while (u < U[mid] || u >= U[mid + 1]) {
        if (u < U[mid]) hi = mid; else lo = mid;
        mid = (lo + hi) >> 1;
    }
    return mid;
}

// Basis functions N[0..p] and (optionally) first derivatives dN[0..p]
function basisFuns(span, u, p, U, N, dN, left, right, Np) {
    N[0] = 1;
    for (let j = 1; j <= p; j++) {
        if (j === p && dN) for (let k = 0; k < p; k++) Np[k] = N[k];
        left[j] = u - U[span + 1 - j];
        right[j] = U[span + j] - u;
        let saved = 0;
        for (let r = 0; r < j; r++) {
            const den = right[r + 1] + left[j - r];
            const tmp = den !== 0 ? N[r] / den : 0;
            N[r] = saved + right[r + 1] * tmp;
            saved = left[j - r] * tmp;
        }
        N[j] = saved;
    }
    if (dN) {
        if (p === 0) { dN[0] = 0; return; }
        for (let k = 0; k <= p; k++) {
            const i = span - p + k;
            let a = 0, b = 0;
            if (k > 0) { const d = U[i + p] - U[i]; if (d !== 0) a = Np[k - 1] / d; }
            if (k < p) { const d = U[i + p + 1] - U[i + 1]; if (d !== 0) b = Np[k] / d; }
            dN[k] = p * (a - b);
        }
    }
}

function expandKnots(mults, knots) {
    const U = [];
    for (let i = 0; i < knots.length; i++) for (let k = 0; k < mults[i]; k++) U.push(knots[i]);
    return Float64Array.from(U);
}

function uniformKnots(nCtrl, p, quasi) {
    const m = nCtrl + p + 1, U = new Float64Array(m);
    if (quasi) {
        const inner = m - 2 * (p + 1);
        for (let i = 0; i < m; i++) U[i] = Math.min(Math.max(i - p, 0), inner + 1);
    } else {
        for (let i = 0; i < m; i++) U[i] = i - p;
    }
    return U;
}

// Read the knot vector from a B_SPLINE_* entity
function knotsFromEntity(e, kind, nCtrl, p, which) {
    const wk = partArgs(e, kind + '_WITH_KNOTS');
    if (wk) {
        const off = e.type === 'COMPLEX' ? 0 : (kind === 'B_SPLINE_CURVE' ? 6 : 8);
        if (kind === 'B_SPLINE_CURVE') return expandKnots(wk[off], wk[off + 1]);
        return which === 0 ? expandKnots(wk[off], wk[off + 2]) : expandKnots(wk[off + 1], wk[off + 3]);
    }
    if (hasPart(e, 'BEZIER_CURVE') || hasPart(e, 'BEZIER_SURFACE')) {
        const U = new Float64Array(2 * (p + 1));
        for (let i = p + 1; i < U.length; i++) U[i] = 1;
        return U;
    }
    if (hasPart(e, 'QUASI_UNIFORM_CURVE') || hasPart(e, 'QUASI_UNIFORM_SURFACE')) return uniformKnots(nCtrl, p, true);
    return uniformKnots(nCtrl, p, false);
}

// --- Curves ---

class LineCurve {
    constructor(p0, dir) {
        this.p0 = p0; this.dir = dir; this.kind = 'line';
        this.t0 = -Infinity; this.t1 = Infinity; this.period = 0;
        this.dd = dot(dir, dir) || 1;
    }
    eval(t) { return madd2(this.p0, this.dir, t, this.dir, 0); }
    d1() { return this.dir; }
    closest(P) { return dot(sub(P, this.p0), this.dir) / this.dd; }
}

class CircleCurve {
    constructor(pl, r) { this.pl = pl; this.r = r; this.kind = 'conic'; this.t0 = 0; this.t1 = TAU; this.period = TAU; this.radius = r; }
    eval(t) { return this.pl.toWorld(this.r * Math.cos(t), this.r * Math.sin(t), 0); }
    d1(t) {
        const { x, y } = this.pl, s = -this.r * Math.sin(t), c = this.r * Math.cos(t);
        return [x[0] * s + y[0] * c, x[1] * s + y[1] * c, x[2] * s + y[2] * c];
    }
    closest(P) {
        const l = this.pl.toLocal(P);
        const t = Math.atan2(l[1], l[0]);
        return t < 0 ? t + TAU : t;
    }
}

class EllipseCurve {
    constructor(pl, a, b) { this.pl = pl; this.a = a; this.b = b; this.kind = 'conic'; this.t0 = 0; this.t1 = TAU; this.period = TAU; this.radius = Math.max(a, b); this.minRadius = Math.min(a, b) ** 2 / Math.max(a, b); }
    eval(t) { return this.pl.toWorld(this.a * Math.cos(t), this.b * Math.sin(t), 0); }
    d1(t) {
        const { x, y } = this.pl, s = -this.a * Math.sin(t), c = this.b * Math.cos(t);
        return [x[0] * s + y[0] * c, x[1] * s + y[1] * c, x[2] * s + y[2] * c];
    }
    closest(P) {
        const l = this.pl.toLocal(P);
        let t = Math.atan2(l[1] / this.b, l[0] / this.a);
        t = newtonCurve(this, P, t);
        t = ((t % TAU) + TAU) % TAU;
        return t;
    }
}

class PolylineCurve {
    constructor(pts) { this.pts = pts; this.kind = 'poly'; this.t0 = 0; this.t1 = pts.length - 1; this.period = 0; }
    eval(t) {
        const n = this.pts.length - 1;
        const i = Math.min(Math.max(Math.floor(t), 0), n - 1), f = t - i;
        const a = this.pts[i], b = this.pts[i + 1];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    d1(t) {
        const n = this.pts.length - 1;
        const i = Math.min(Math.max(Math.floor(t), 0), n - 1);
        return sub(this.pts[i + 1], this.pts[i]);
    }
    closest(P) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < this.pts.length - 1; i++) {
            const a = this.pts[i], d = sub(this.pts[i + 1], a), dd = dot(d, d) || 1;
            const f = Math.min(Math.max(dot(sub(P, a), d) / dd, 0), 1);
            const q = madd2(a, d, f, d, 0), dq = dist2(P, q);
            if (dq < bd) { bd = dq; best = i + f; }
        }
        return best;
    }
}

export class BSplineCurve {
    constructor(p, ctrl, weights, U) {
        this.p = p; this.n = ctrl.length - 1; this.U = U; this.kind = 'spline';
        this.cw = new Float64Array(ctrl.length * 4); // homogeneous control points (x*w, y*w, z*w, w)
        for (let i = 0; i < ctrl.length; i++) {
            const w = weights ? weights[i] : 1;
            this.cw[i * 4] = ctrl[i][0] * w; this.cw[i * 4 + 1] = ctrl[i][1] * w; this.cw[i * 4 + 2] = ctrl[i][2] * w; this.cw[i * 4 + 3] = w;
        }
        this.rational = !!weights;
        this.t0 = U[p]; this.t1 = U[this.n + 1];
        this.closed = dist(ctrl[0], ctrl[this.n]) < 1e-7 * (1 + len(ctrl[0]));
        this.period = 0;
        const sz = p + 1;
        this._N = new Float64Array(sz); this._dN = new Float64Array(sz); this._l = new Float64Array(sz + 1);
        this._r = new Float64Array(sz + 1); this._Np = new Float64Array(sz);
        this.samples = null;
    }
    _ev(t, deriv) {
        t = Math.min(Math.max(t, this.t0), this.t1);
        const { p, U, cw, _N: N, _dN: dN } = this;
        const span = findSpan(this.n, p, t, U);
        basisFuns(span, t, p, U, N, deriv ? dN : null, this._l, this._r, this._Np);
        let x = 0, y = 0, z = 0, w = 0, dx = 0, dy = 0, dz = 0, dw = 0;
        for (let k = 0; k <= p; k++) {
            const i = (span - p + k) * 4, b = N[k];
            x += cw[i] * b; y += cw[i + 1] * b; z += cw[i + 2] * b; w += cw[i + 3] * b;
            if (deriv) { const d = dN[k]; dx += cw[i] * d; dy += cw[i + 1] * d; dz += cw[i + 2] * d; dw += cw[i + 3] * d; }
        }
        const P = [x / w, y / w, z / w];
        if (!deriv) return P;
        return [P, [(dx - dw * P[0]) / w, (dy - dw * P[1]) / w, (dz - dw * P[2]) / w]];
    }
    eval(t) { return this._ev(t, false); }
    d1(t) { return this._ev(t, true)[1]; }
    closest(P, guess) {
        if (guess === undefined || guess === null) {
            if (!this.samples) {
                const n = Math.min(Math.max((this.n + 1) * 4, 32), 400);
                this.samples = [];
                for (let i = 0; i <= n; i++) {
                    const t = this.t0 + (this.t1 - this.t0) * i / n;
                    this.samples.push([t, this.eval(t)]);
                }
            }
            let bd = Infinity;
            for (const [t, q] of this.samples) {
                const d = dist2(P, q);
                if (d < bd) { bd = d; guess = t; }
            }
        }
        return newtonCurve(this, P, guess);
    }
}

// Gauss-Newton: minimizes |C(t) - P|
function newtonCurve(c, P, t) {
    for (let it = 0; it < 30; it++) {
        const q = c.eval(t), d = c.d1(t);
        const dd = dot(d, d);
        if (dd < 1e-30) break;
        let dt = dot(sub(P, q), d) / dd;
        let tn = t + dt;
        if (c.period === 0 && isFinite(c.t0)) tn = Math.min(Math.max(tn, c.t0), c.t1);
        if (Math.abs(tn - t) < 1e-12 * (1 + Math.abs(t))) { t = tn; break; }
        t = tn;
    }
    return t;
}

// --- Surfaces ---

class SurfaceBase {
    constructor() { this.uPeriod = 0; this.vPeriod = 0; this.isPlane = false; }
    eval(u, v) { return this.evalD(u, v).p; }
    // Normal = du x dv; at singularities (poles, cone apex) substitute from neighbouring points
    normal(u, v) {
        const d = this.evalD(u, v);
        let n = cross(d.du, d.dv), l = len(n);
        if (l > 1e-14 * (len(d.du) * len(d.dv) + 1e-300) && l > 1e-24) return scale(n, 1 / l);
        let best = null, bl = 0;
        const eu = this.epsU || 1e-5, ev = this.epsV || 1e-5;
        for (const [a, b] of [[0, ev], [0, -ev], [eu, 0], [-eu, 0]]) {
            const e = this.evalD(u + a, v + b);
            const m = cross(e.du, e.dv), ml = len(m);
            if (ml > bl) { bl = ml; best = m; }
        }
        return bl > 0 ? scale(best, 1 / bl) : [0, 0, 1];
    }
    // Gauss-Newton refinement of a projection
    refine(P, u, v, iters = 20) {
        for (let it = 0; it < iters; it++) {
            const { p, du, dv } = this.evalD(u, v);
            const r = sub(P, p);
            const a = dot(du, du), b = dot(du, dv), c = dot(dv, dv);
            const ru = dot(r, du), rv = dot(r, dv);
            const det = a * c - b * b;
            let su, sv;
            if (Math.abs(det) > 1e-30 * (a * c + 1e-300)) {
                su = (ru * c - rv * b) / det; sv = (rv * a - ru * b) / det;
            } else {
                // singular (e.g. pole): only the non-degenerate direction
                su = a > 1e-30 ? ru / a : 0; sv = c > 1e-30 ? rv / c : 0;
            }
            let un = u + su, vn = v + sv;
            if (this.clamp) [un, vn] = this.clamp(un, vn);
            const conv = Math.abs(un - u) <= 1e-12 * (1 + Math.abs(u)) && Math.abs(vn - v) <= 1e-12 * (1 + Math.abs(v));
            u = un; v = vn;
            if (conv) break;
        }
        return [u, v];
    }
}

class PlaneSurface extends SurfaceBase {
    constructor(pl) { super(); this.pl = pl; this.isPlane = true; }
    evalD(u, v) { return { p: this.pl.toWorld(u, v, 0), du: this.pl.x, dv: this.pl.y }; }
    normal() { return this.pl.z; }
    project(P) { const l = this.pl.toLocal(P); return [l[0], l[1]]; }
}

class CylinderSurface extends SurfaceBase {
    constructor(pl, r) { super(); this.pl = pl; this.r = r; this.uPeriod = TAU; this.uScale = r; }
    evalD(u, v) {
        const { x, y, z } = this.pl, c = Math.cos(u), s = Math.sin(u), r = this.r;
        const radial = [x[0] * c + y[0] * s, x[1] * c + y[1] * s, x[2] * c + y[2] * s];
        return {
            p: madd2(this.pl.o, radial, r, z, v),
            du: [(-x[0] * s + y[0] * c) * r, (-x[1] * s + y[1] * c) * r, (-x[2] * s + y[2] * c) * r],
            dv: z,
        };
    }
    project(P) { const l = this.pl.toLocal(P); return [Math.atan2(l[1], l[0]), l[2]]; }
}

class ConeSurface extends SurfaceBase {
    // STEP: radius r at the origin, half-angle a; v runs along the axis (length)
    constructor(pl, r, a) { super(); this.pl = pl; this.r = r; this.t = Math.tan(a); this.uPeriod = TAU; }
    evalD(u, v) {
        const { x, y, z } = this.pl, c = Math.cos(u), s = Math.sin(u), rho = this.r + v * this.t;
        const radial = [x[0] * c + y[0] * s, x[1] * c + y[1] * s, x[2] * c + y[2] * s];
        const tang = [-x[0] * s + y[0] * c, -x[1] * s + y[1] * c, -x[2] * s + y[2] * c];
        return {
            p: madd2(this.pl.o, radial, rho, z, v),
            du: scale(tang, rho),
            dv: madd2(z, radial, this.t, radial, 0),
        };
    }
    project(P) {
        const l = this.pl.toLocal(P);
        return [Math.atan2(l[1], l[0]), l[2]];
    }
    domain() {
        if (!this.t) return null;
        const apex = -this.r / this.t;
        return this.t > 0 ? [0, TAU, apex, Infinity] : [0, TAU, -Infinity, apex];
    }
}

class SphereSurface extends SurfaceBase {
    constructor(pl, r) { super(); this.pl = pl; this.r = r; this.uPeriod = TAU; }
    evalD(u, v) {
        const { x, y, z } = this.pl, r = this.r;
        const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
        const radial = [x[0] * cu + y[0] * su, x[1] * cu + y[1] * su, x[2] * cu + y[2] * su];
        const tang = [-x[0] * su + y[0] * cu, -x[1] * su + y[1] * cu, -x[2] * su + y[2] * cu];
        return {
            p: madd2(this.pl.o, radial, r * cv, z, r * sv),
            du: scale(tang, r * cv),
            dv: madd2([0, 0, 0], radial, -r * sv, z, r * cv),
        };
    }
    normal(u, v) { return normalize(sub(this.eval(u, v), this.pl.o)); }
    domain() { return [0, TAU, -Math.PI / 2, Math.PI / 2]; }
    project(P) {
        const l = this.pl.toLocal(P);
        const h = Math.hypot(l[0], l[1]);
        return [Math.atan2(l[1], l[0]), Math.atan2(l[2], h)];
    }
}

class TorusSurface extends SurfaceBase {
    constructor(pl, R, r) { super(); this.pl = pl; this.R = R; this.r = r; this.uPeriod = TAU; this.vPeriod = TAU; }
    evalD(u, v) {
        const { x, y, z } = this.pl, R = this.R, r = this.r;
        const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
        const radial = [x[0] * cu + y[0] * su, x[1] * cu + y[1] * su, x[2] * cu + y[2] * su];
        const tang = [-x[0] * su + y[0] * cu, -x[1] * su + y[1] * cu, -x[2] * su + y[2] * cu];
        const rho = R + r * cv;
        return {
            p: madd2(this.pl.o, radial, rho, z, r * sv),
            du: scale(tang, rho),
            dv: madd2([0, 0, 0], radial, -r * sv, z, r * cv),
        };
    }
    project(P) {
        const l = this.pl.toLocal(P);
        const h = Math.hypot(l[0], l[1]);
        return [Math.atan2(l[1], l[0]), Math.atan2(l[2], h - this.R)];
    }
    domain() { return [0, TAU, 0, TAU]; }
}

class BSplineSurface extends SurfaceBase {
    constructor(pu, pv, ctrl, weights, Uu, Uv, uClosed, vClosed) {
        super();
        this.pu = pu; this.pv = pv; this.Uu = Uu; this.Uv = Uv;
        this.nu = ctrl.length - 1; this.nv = ctrl[0].length - 1;
        const cols = this.nv + 1;
        this.cols = cols;
        this.cw = new Float64Array((this.nu + 1) * cols * 4);
        for (let i = 0; i <= this.nu; i++) for (let j = 0; j <= this.nv; j++) {
            const P = ctrl[i][j], w = weights ? weights[i][j] : 1, k = (i * cols + j) * 4;
            this.cw[k] = P[0] * w; this.cw[k + 1] = P[1] * w; this.cw[k + 2] = P[2] * w; this.cw[k + 3] = w;
        }
        this.u0 = Uu[pu]; this.u1 = Uu[this.nu + 1];
        this.v0 = Uv[pv]; this.v1 = Uv[this.nv + 1];
        this.epsU = (this.u1 - this.u0) * 1e-5; this.epsV = (this.v1 - this.v0) * 1e-5;
        const mk = n => new Float64Array(n);
        this._Nu = mk(pu + 1); this._dNu = mk(pu + 1); this._Nv = mk(pv + 1); this._dNv = mk(pv + 1);
        this._l = mk(Math.max(pu, pv) + 2); this._r = mk(Math.max(pu, pv) + 2); this._Np = mk(Math.max(pu, pv) + 1);
        this.grid = null;
        // Treat closed surfaces like periodic ones (seam). Checked geometrically: the
        // u_closed/v_closed flag and coinciding control point rows are not reliable in
        // exports (e.g. spline cones closed in u without the flag).
        if ((uClosed && this.rowsCoincide(true)) || this.edgesCoincide(true)) this.uPeriod = this.u1 - this.u0;
        if ((vClosed && this.rowsCoincide(false)) || this.edgesCoincide(false)) this.vPeriod = this.v1 - this.v0;
    }
    // Does the edge u=u0 coincide with u=u1 (or v=v0 with v=v1)? Samples on the surface.
    edgesCoincide(alongU) {
        const { cw } = this;
        let size = 0;
        for (let k = 0; k < cw.length; k += 4) size = Math.max(size, Math.abs(cw[k] / cw[k + 3]), Math.abs(cw[k + 1] / cw[k + 3]), Math.abs(cw[k + 2] / cw[k + 3]));
        const tol = 1e-6 * (1 + size);
        let spread = 0;
        const N = 9;
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            let a, b;
            if (alongU) {
                const v = this.v0 + (this.v1 - this.v0) * t;
                a = this.evalD(this.u0, v).p; b = this.evalD(this.u1, v).p;
            } else {
                const u = this.u0 + (this.u1 - this.u0) * t;
                a = this.evalD(u, this.v0).p; b = this.evalD(u, this.v1).p;
            }
            if (dist(a, b) > tol) return false;
            if (i === 0) var first = a; else spread = Math.max(spread, dist(a, first));
        }
        // an edge degenerated to a point (pole) is not a seam
        return spread > tol * 10;
    }
    rowsCoincide(alongU) {
        const { cw, cols } = this;
        const n = alongU ? this.nv : this.nu;
        let maxd = 0, size = 0;
        for (let k = 0; k <= n; k++) {
            const a = alongU ? k * 4 : k * cols * 4;
            const b = alongU ? (this.nu * cols + k) * 4 : (k * cols + this.nv) * 4;
            const pa = [cw[a] / cw[a + 3], cw[a + 1] / cw[a + 3], cw[a + 2] / cw[a + 3]];
            const pb = [cw[b] / cw[b + 3], cw[b + 1] / cw[b + 3], cw[b + 2] / cw[b + 3]];
            maxd = Math.max(maxd, dist(pa, pb)); size = Math.max(size, len(pa));
        }
        return maxd < 1e-6 * (1 + size);
    }
    wrap(u, v) {
        if (this.uPeriod) u = this.u0 + ((((u - this.u0) % this.uPeriod) + this.uPeriod) % this.uPeriod);
        if (this.vPeriod) v = this.v0 + ((((v - this.v0) % this.vPeriod) + this.vPeriod) % this.vPeriod);
        return [u, v];
    }
    domain() { return [this.u0, this.u1, this.v0, this.v1]; }
    clamp(u, v) {
        if (!this.uPeriod) u = Math.min(Math.max(u, this.u0), this.u1);
        if (!this.vPeriod) v = Math.min(Math.max(v, this.v0), this.v1);
        return [u, v];
    }
    evalD(u, v) {
        [u, v] = this.wrap(u, v);
        u = Math.min(Math.max(u, this.u0), this.u1);
        v = Math.min(Math.max(v, this.v0), this.v1);
        const { pu, pv, cw, cols } = this;
        const su = findSpan(this.nu, pu, u, this.Uu), sv = findSpan(this.nv, pv, v, this.Uv);
        const Nu = this._Nu, dNu = this._dNu, Nv = this._Nv, dNv = this._dNv;
        basisFuns(su, u, pu, this.Uu, Nu, dNu, this._l, this._r, this._Np);
        basisFuns(sv, v, pv, this.Uv, Nv, dNv, this._l, this._r, this._Np);
        let x = 0, y = 0, z = 0, w = 0, xu = 0, yu = 0, zu = 0, wu = 0, xv = 0, yv = 0, zv = 0, wv = 0;
        for (let a = 0; a <= pu; a++) {
            const row = (su - pu + a) * cols;
            const na = Nu[a], da = dNu[a];
            for (let b = 0; b <= pv; b++) {
                const k = (row + sv - pv + b) * 4;
                const nb = Nv[b], db = dNv[b];
                const f = na * nb, fu = da * nb, fv = na * db;
                const cx = cw[k], cy = cw[k + 1], cz = cw[k + 2], cwt = cw[k + 3];
                x += cx * f; y += cy * f; z += cz * f; w += cwt * f;
                xu += cx * fu; yu += cy * fu; zu += cz * fu; wu += cwt * fu;
                xv += cx * fv; yv += cy * fv; zv += cz * fv; wv += cwt * fv;
            }
        }
        const p = [x / w, y / w, z / w];
        return {
            p,
            du: [(xu - wu * p[0]) / w, (yu - wu * p[1]) / w, (zu - wu * p[2]) / w],
            dv: [(xv - wv * p[0]) / w, (yv - wv * p[1]) / w, (zv - wv * p[2]) / w],
        };
    }
    buildGrid() {
        const nu = Math.min(Math.max((this.nu + 1) * 3, 12), 80);
        const nv = Math.min(Math.max((this.nv + 1) * 3, 12), 80);
        const pts = new Float64Array((nu + 1) * (nv + 1) * 3);
        for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
            const p = this.evalD(this.u0 + (this.u1 - this.u0) * i / nu, this.v0 + (this.v1 - this.v0) * j / nv).p;
            const k = (i * (nv + 1) + j) * 3;
            pts[k] = p[0]; pts[k + 1] = p[1]; pts[k + 2] = p[2];
        }
        this.grid = { nu, nv, pts };
    }
    project(P, guess) {
        if (guess) {
            const r = this.refine(P, guess[0], guess[1], 12);
            const q = this.evalD(r[0], r[1]).p;
            // reference scale: derivative length
            if (dist(q, P) < 1e-4 * (1 + this.size())) return r;
        }
        if (!this.grid) this.buildGrid();
        const { nu, nv, pts } = this.grid;
        let bd = Infinity, bi = 0, bj = 0;
        for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
            const k = (i * (nv + 1) + j) * 3;
            const d = (pts[k] - P[0]) ** 2 + (pts[k + 1] - P[1]) ** 2 + (pts[k + 2] - P[2]) ** 2;
            if (d < bd) { bd = d; bi = i; bj = j; }
        }
        return this.refine(P, this.u0 + (this.u1 - this.u0) * bi / nu, this.v0 + (this.v1 - this.v0) * bj / nv, 30);
    }
    size() {
        if (this._size === undefined) {
            const { cw } = this;
            let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
            for (let k = 0; k < cw.length; k += 4) for (let c = 0; c < 3; c++) {
                const val = cw[k + c] / cw[k + 3];
                if (val < mn[c]) mn[c] = val; if (val > mx[c]) mx[c] = val;
            }
            this._size = dist(mn, mx);
        }
        return this._size;
    }
}

class ExtrusionSurface extends SurfaceBase {
    // S(u, v) = C(u) + v * D
    constructor(curve, D) {
        super(); this.c = curve; this.D = D; this.uPeriod = curve.period;
        if (isFinite(curve.t0) && !curve.period) this.clamp = (u, v) => [Math.min(Math.max(u, curve.t0), curve.t1), v];
    }
    evalD(u, v) { return { p: madd2(this.c.eval(u), this.D, v, this.D, 0), du: this.c.d1(u), dv: this.D }; }
    project(P, guess) {
        const dd = dot(this.D, this.D);
        // move P into the plane perpendicular to D at the curve start, then project onto the curve
        let u;
        if (guess) u = guess[0];
        else {
            const ref = this.c.eval(isFinite(this.c.t0) ? this.c.t0 : 0);
            const Pp = sub(P, scale(this.D, dot(sub(P, ref), this.D) / dd));
            u = this.c.closest(Pp);
        }
        const v = dot(sub(P, this.c.eval(u)), this.D) / dd;
        return this.refine(P, u, v);
    }
}

class RevolutionSurface extends SurfaceBase {
    // S(u, v) = rotation of C(v) about the axis by angle u
    constructor(curve, o, k) {
        super(); this.c = curve; this.o = o; this.k = normalize(k); this.uPeriod = TAU; this.vPeriod = curve.period;
        if (isFinite(curve.t0) && !curve.period) this.clamp = (u, v) => [u, Math.min(Math.max(v, curve.t0), curve.t1)];
    }
    rot(w, c, s) {
        const k = this.k, kw = dot(k, w), kx = cross(k, w);
        return [w[0] * c + kx[0] * s + k[0] * kw * (1 - c), w[1] * c + kx[1] * s + k[1] * kw * (1 - c), w[2] * c + kx[2] * s + k[2] * kw * (1 - c)];
    }
    evalD(u, v) {
        const C = this.c.eval(v), dC = this.c.d1(v), c = Math.cos(u), s = Math.sin(u);
        const w = sub(C, this.o), k = this.k, kw = dot(k, w), kx = cross(k, w);
        return {
            p: add(this.o, this.rot(w, c, s)),
            du: [-w[0] * s + kx[0] * c + k[0] * kw * s, -w[1] * s + kx[1] * c + k[1] * kw * s, -w[2] * s + kx[2] * c + k[2] * kw * s],
            dv: this.rot(dC, c, s),
        };
    }
    domain() { return isFinite(this.c.t0) ? [0, TAU, this.c.t0, this.c.t1] : null; }
    angleOf(P, ref) {
        // angle from ref to P about the axis
        const k = this.k;
        const a = sub(ref, this.o), b = sub(P, this.o);
        const ap = sub(a, scale(k, dot(a, k))), bp = sub(b, scale(k, dot(b, k)));
        return Math.atan2(dot(cross(ap, bp), k), dot(ap, bp));
    }
    project(P, guess) {
        if (guess) return this.refine(P, guess[0], guess[1]);
        // rotate P into the half-plane of the curve, project onto the curve there
        const tm = isFinite(this.c.t0) ? (this.c.t0 + this.c.t1) / 2 : 0;
        const Cm = this.c.eval(tm);
        const ang = this.angleOf(P, Cm);
        const Pr = add(this.o, this.rot(sub(P, this.o), Math.cos(-ang), Math.sin(-ang)));
        const v = this.c.closest(Pr);
        const u = this.angleOf(P, this.c.eval(v));
        return this.refine(P, u, v);
    }
}

class OffsetSurface extends SurfaceBase {
    constructor(base, d) {
        super(); this.b = base; this.d = d; this.uPeriod = base.uPeriod; this.vPeriod = base.vPeriod;
        this.epsU = base.epsU; this.epsV = base.epsV; if (base.clamp) this.clamp = base.clamp.bind(base);
    }
    evalD(u, v) {
        const p = add(this.b.eval(u, v), scale(this.b.normal(u, v), this.d));
        const h = 1e-6;
        const pu = add(this.b.eval(u + h, v), scale(this.b.normal(u + h, v), this.d));
        const pv = add(this.b.eval(u, v + h), scale(this.b.normal(u, v + h), this.d));
        return { p, du: scale(sub(pu, p), 1 / h), dv: scale(sub(pv, p), 1 / h) };
    }
    project(P, guess) {
        const g = this.b.project(P, guess);
        return this.refine(P, g[0], g[1]);
    }
}

// --- Factory: STEP entity -> geometry object ---

export class GeometryBuilder {
    constructor(step, angleUnit = 1) {
        this.step = step;
        this.angleUnit = angleUnit;
        this.curves = new Map();
        this.surfaces = new Map();
    }

    point(ref) {
        const e = this.step.get(ref);
        if (!e) throw new Error('Point missing: #' + (ref && ref.id));
        if (e.type === 'CARTESIAN_POINT') {
            const c = e.args[1];
            return [c[0] || 0, c[1] || 0, c.length > 2 ? c[2] : 0];
        }
        if (e.type === 'VERTEX_POINT') return this.point(e.args[1]);
        throw new Error('Not a point: ' + e.type);
    }

    direction(ref) {
        if (!ref) return null;
        const e = this.step.get(ref);
        if (e.type === 'DIRECTION') {
            const c = e.args[1];
            return [c[0] || 0, c[1] || 0, c.length > 2 ? c[2] : 0];
        }
        if (e.type === 'VECTOR') return scale(normalize(this.direction(e.args[1])), e.args[2]);
        throw new Error('Not a direction: ' + e.type);
    }

    placement(ref) {
        const e = this.step.get(ref);
        if (!e) return makeFrame([0, 0, 0]);
        if (e.type === 'AXIS2_PLACEMENT_3D') {
            return makeFrame(this.point(e.args[1]), this.direction(e.args[2]), this.direction(e.args[3]));
        }
        if (e.type === 'AXIS1_PLACEMENT') return makeFrame(this.point(e.args[1]), this.direction(e.args[2]));
        if (e.type === 'AXIS2_PLACEMENT_2D') {
            const p = this.point(e.args[1]), x = this.direction(e.args[2]) || [1, 0, 0];
            return makeFrame(p, [0, 0, 1], x);
        }
        if (e.type === 'CARTESIAN_TRANSFORMATION_OPERATOR_3D') {
            // (name, desc, axis1, axis2, origin, scale, axis3)
            const a = e.args;
            return makeFrame(this.point(a[4]), this.direction(a[6]), this.direction(a[2]));
        }
        throw new Error('Unknown placement: ' + e.type);
    }

    curve(ref) {
        const id = ref instanceof Ref ? ref.id : ref;
        let c = this.curves.get(id);
        if (c) return c;
        c = this.buildCurve(this.step.get(id));
        this.curves.set(id, c);
        return c;
    }

    buildCurve(e) {
        if (!e) throw new Error('Curve missing');
        const a = e.args;
        switch (e.type) {
            case 'LINE': return new LineCurve(this.point(a[1]), this.direction(a[2]));
            case 'CIRCLE': return new CircleCurve(this.placement(a[1]), a[2]);
            case 'ELLIPSE': return new EllipseCurve(this.placement(a[1]), a[2], a[3]);
            case 'POLYLINE': return new PolylineCurve(a[1].map(r => this.point(r)));
            case 'SURFACE_CURVE': case 'SEAM_CURVE': case 'BOUNDED_SURFACE_CURVE': case 'INTERSECTION_CURVE':
                return this.curve(a[1]);
            case 'TRIMMED_CURVE': return this.curve(a[1]);
            case 'B_SPLINE_CURVE_WITH_KNOTS': case 'BEZIER_CURVE': case 'UNIFORM_CURVE': case 'QUASI_UNIFORM_CURVE':
            case 'COMPLEX':
                return this.buildBSplineCurve(e);
        }
        throw new Error('Curve type not supported: ' + e.type);
    }

    buildBSplineCurve(e) {
        let base, weights = null;
        if (e.type === 'COMPLEX') {
            base = e.parts.B_SPLINE_CURVE;
            if (!base) {
                if (e.parts.SURFACE_CURVE) return this.curve(e.parts.SURFACE_CURVE[0]);
                throw new Error('Complex curve not supported: ' + Object.keys(e.parts).join(','));
            }
            const rat = e.parts.RATIONAL_B_SPLINE_CURVE;
            if (rat) weights = rat[0];
        } else {
            base = e.args.slice(1); // drop the name
        }
        const p = base[0], ctrl = base[1].map(r => this.point(r));
        const U = knotsFromEntity(e, 'B_SPLINE_CURVE', ctrl.length, p, 0);
        return new BSplineCurve(p, ctrl, weights, U);
    }

    surface(ref) {
        const id = ref instanceof Ref ? ref.id : ref;
        let s = this.surfaces.get(id);
        if (s) return s;
        s = this.buildSurface(this.step.get(id));
        this.surfaces.set(id, s);
        return s;
    }

    buildSurface(e) {
        if (!e) throw new Error('Surface missing');
        const a = e.args;
        switch (e.type) {
            case 'PLANE': return new PlaneSurface(this.placement(a[1]));
            case 'CYLINDRICAL_SURFACE': return new CylinderSurface(this.placement(a[1]), a[2]);
            case 'CONICAL_SURFACE': return new ConeSurface(this.placement(a[1]), a[2], a[3] * this.angleUnit);
            case 'SPHERICAL_SURFACE': return new SphereSurface(this.placement(a[1]), a[2]);
            case 'TOROIDAL_SURFACE': case 'DEGENERATE_TOROIDAL_SURFACE':
                return new TorusSurface(this.placement(a[1]), a[2], a[3]);
            case 'SURFACE_OF_LINEAR_EXTRUSION': return new ExtrusionSurface(this.curve(a[1]), this.direction(a[2]));
            case 'SURFACE_OF_REVOLUTION': {
                const pl = this.placement(a[2]);
                return new RevolutionSurface(this.curve(a[1]), pl.o, pl.z);
            }
            case 'OFFSET_SURFACE': return new OffsetSurface(this.surface(a[1]), a[2]);
            case 'RECTANGULAR_TRIMMED_SURFACE': return this.surface(a[1]);
            case 'B_SPLINE_SURFACE_WITH_KNOTS': case 'BEZIER_SURFACE': case 'UNIFORM_SURFACE': case 'QUASI_UNIFORM_SURFACE':
            case 'COMPLEX':
                return this.buildBSplineSurface(e);
        }
        throw new Error('Surface type not supported: ' + e.type);
    }

    buildBSplineSurface(e) {
        let base, weights = null;
        if (e.type === 'COMPLEX') {
            base = e.parts.B_SPLINE_SURFACE;
            if (!base) throw new Error('Complex surface not supported: ' + Object.keys(e.parts).join(','));
            const rat = e.parts.RATIONAL_B_SPLINE_SURFACE;
            if (rat) weights = rat[0];
        } else {
            base = e.args.slice(1);
        }
        const pu = base[0], pv = base[1];
        const ctrl = base[2].map(row => row.map(r => this.point(r)));
        const Uu = knotsFromEntity(e, 'B_SPLINE_SURFACE', ctrl.length, pu, 0);
        const Uv = knotsFromEntity(e, 'B_SPLINE_SURFACE', ctrl[0].length, pv, 1);
        return new BSplineSurface(pu, pv, ctrl, weights, Uu, Uv, base[4] === true, base[5] === true);
    }
}
