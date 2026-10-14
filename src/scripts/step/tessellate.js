// Tessellation of B-rep faces (ADVANCED_FACE) into triangles.
//
// Steps per face:
//  1. Edges are sampled once (deterministically) in 3D and cached, so neighbouring
//     faces share exactly the same boundary points -> watertight.
//  2. Boundary points are projected into the parameter space (u, v) of the surface, periodic
//     parameters unwrapped, poles/singularities resolved, seams cut open.
//  3. Triangulation of the (u, v) polygon with earcut, followed by Delaunay flips.
//  4. Curved surfaces: adaptive refinement (edge/triangle split) until chord error
//     and normal angle are below the tolerance, with local Delaunay legalization.

import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import cdt2d from 'cdt2d';
import { GeometryBuilder, sub, dot, cross, len, dist, dist2, wrapNear } from './geometry.js';

const MAX_FACE_VERTS = 60000;

// --- Edge sampling ---

function sampleParams(curve, ta, tb, defl, ang) {
    const span = tb - ta;
    if (curve.kind === 'conic') {
        let step = ang;
        const R = curve.radius;
        if (defl < R) step = Math.min(step, 2 * Math.acos(1 - defl / R));
        const n = Math.min(Math.max(Math.ceil(Math.abs(span) / step), 1), 4096);
        const ts = new Array(n + 1);
        for (let i = 0; i <= n; i++) ts[i] = ta + span * i / n;
        return ts;
    }
    if (curve.kind === 'poly') {
        const ts = [ta];
        const dir = span >= 0 ? 1 : -1;
        for (let k = dir > 0 ? Math.floor(ta) + 1 : Math.ceil(ta) - 1; dir > 0 ? k < tb : k > tb; k += dir) ts.push(k);
        ts.push(tb);
        return ts;
    }
    // B-spline: initial subdivision per knot interval, then adaptive bisection
    const base = [ta];
    const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
    const sub0 = Math.max(curve.p || 2, 2);
    const knots = [];
    if (curve.U) {
        for (let i = 0; i < curve.U.length; i++) {
            const k = curve.U[i];
            if (k > lo && k < hi && (knots.length === 0 || knots[knots.length - 1] !== k)) knots.push(k);
        }
    }
    if (tb < ta) knots.reverse();
    const brk = [ta, ...knots, tb];
    for (let i = 0; i < brk.length - 1; i++) {
        for (let j = 1; j <= sub0; j++) base.push(brk[i] + (brk[i + 1] - brk[i]) * j / sub0);
    }
    const out = [ta];
    const pts = base.map(t => curve.eval(t));
    const cosA = Math.cos(ang);
    const rec = (t0, p0, t1, p1, depth) => {
        const tm = (t0 + t1) / 2, pm = curve.eval(tm);
        const mx = (p0[0] + p1[0]) / 2 - pm[0], my = (p0[1] + p1[1]) / 2 - pm[1], mz = (p0[2] + p1[2]) / 2 - pm[2];
        const dev2 = mx * mx + my * my + mz * mz;
        let split = dev2 > defl * defl;
        if (!split) {
            const a = sub(pm, p0), b = sub(p1, pm);
            const la = len(a), lb = len(b);
            if (la > 0 && lb > 0 && dot(a, b) < cosA * la * lb) split = true;
        }
        if (split && depth < 12 && dist2(p0, p1) > defl * defl * 1e-4) {
            rec(t0, p0, tm, pm, depth + 1);
            rec(tm, pm, t1, p1, depth + 1);
        } else {
            out.push(t1);
        }
    };
    for (let i = 0; i < base.length - 1; i++) rec(base[i], pts[i], base[i + 1], pts[i + 1], 0);
    return out;
}

// --- Half-edge triangle mesh with Delaunay operations ---

class TriMesh {
    constructor(sx, sy) {
        this.X = sx; this.Y = sy;   // scaled uv coordinates (for geometric tests)
        this.V = []; this.N = []; this.C = []; // corners, neighbours, constraint per half-edge (0 free, 1 seam, 2 boundary)
    }
    get count() { return this.V.length / 3; }
    orient(a, b, c) {
        const X = this.X, Y = this.Y;
        return (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
    }
    // Strictly counter-clockwise – with relative tolerance: for (nearly) collinear points
    // (e.g. boundary points on a uv line) orient() returns rounding noise > 0, a flip
    // would then create a triangle without area.
    ccw(a, b, c) {
        const X = this.X, Y = this.Y;
        const o = this.orient(a, b, c);
        const l = (X[b] - X[a]) ** 2 + (Y[b] - Y[a]) ** 2 + (X[c] - X[b]) ** 2 + (Y[c] - Y[b]) ** 2 + (X[a] - X[c]) ** 2 + (Y[a] - Y[c]) ** 2;
        return o > 1e-9 * l;
    }
    incircle(a, b, c, d) {
        const X = this.X, Y = this.Y;
        const adx = X[a] - X[d], ady = Y[a] - Y[d], bdx = X[b] - X[d], bdy = Y[b] - Y[d], cdx = X[c] - X[d], cdy = Y[c] - Y[d];
        const ad = adx * adx + ady * ady, bd = bdx * bdx + bdy * bdy, cd = cdx * cdx + cdy * cdy;
        return adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx);
    }
    // Index of half-edge x->y in triangle t
    edgeIndex(t, x, y) {
        const V = this.V, b = 3 * t;
        for (let k = 0; k < 3; k++) if (V[b + k] === x && V[b + (k + 1) % 3] === y) return k;
        return -1;
    }
    replaceNb(n, x, y, nw) {
        if (n < 0) return;
        const k = this.edgeIndex(n, y, x);
        if (k >= 0) this.N[3 * n + k] = nw;
    }
    set(t, a, b, c, na, nb, nc, ca, cb, cc) {
        const i = 3 * t, V = this.V, N = this.N, C = this.C;
        V[i] = a; V[i + 1] = b; V[i + 2] = c;
        N[i] = na; N[i + 1] = nb; N[i + 2] = nc;
        C[i] = ca; C[i + 1] = cb; C[i + 2] = cc;
    }
    // Build adjacency from the triangle list; ringEdges: Map key(a,b) -> constraint
    build(tris, ringEdges, K) {
        const V = this.V, N = this.N, C = this.C;
        // earcut returns consistently oriented triangles; the orientation is determined
        // globally (not per triangle) so nearly degenerate slivers do not disturb the topology
        let sum = 0;
        for (let i = 0; i < tris.length; i += 3) sum += this.orient(tris[i], tris[i + 1], tris[i + 2]);
        const rev = sum < 0;
        for (let i = 0; i < tris.length; i += 3) {
            if (rev) V.push(tris[i], tris[i + 2], tris[i + 1]);
            else V.push(tris[i], tris[i + 1], tris[i + 2]);
            N.push(-1, -1, -1); C.push(0, 0, 0);
        }
        const open = new Map();
        for (let h = 0; h < V.length; h++) {
            const a = V[h], b = V[h - h % 3 + (h % 3 + 1) % 3];
            const key = a < b ? a * K + b : b * K + a;
            const rc = ringEdges.get(key);
            if (rc !== undefined) C[h] = rc;
            const o = open.get(key);
            if (o !== undefined) { N[h] = (o / 3) | 0; N[o] = (h / 3) | 0; open.delete(key); }
            else open.set(key, h);
        }
        // Fix boundary edges without neighbours that do not lie on a ring (degenerate cases)
        for (let h = 0; h < V.length; h++) if (N[h] < 0 && C[h] === 0) C[h] = 2;
    }
    // Validity: every boundary edge (consecutive ring points) is a triangle edge and no
    // triangle is flipped
    isValid(ringStarts, n) {
        const V = this.V, X = this.X, Y = this.Y;
        const edges = new Set();
        const K = 1 << 22;
        for (let t = 0; t < V.length; t += 3) {
            const a = V[t], b = V[t + 1], c = V[t + 2];
            // flipped triangles are invalid; thin (nearly collinear) ones are allowed
            const o = this.orient(a, b, c);
            const l = (X[b] - X[a]) ** 2 + (Y[b] - Y[a]) ** 2 + (X[c] - X[b]) ** 2 + (Y[c] - Y[b]) ** 2 + (X[a] - X[c]) ** 2 + (Y[a] - Y[c]) ** 2;
            if (o < -1e-9 * l) return false;
            for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.add(p < q ? p * K + q : q * K + p);
        }
        const starts = [...ringStarts, n];
        for (let r = 0; r < ringStarts.length; r++) {
            const s = starts[r], m = starts[r + 1] - s;
            for (let i = 0; i < m; i++) {
                const p = s + i, q = s + (i + 1) % m;
                if (X[p] === X[q] && Y[p] === Y[q]) continue;
                if (!edges.has(p < q ? p * K + q : q * K + p)) return false;
            }
        }
        return true;
    }
    // earcut drops exactly collinear points. These boundary points are inserted back into
    // the respective boundary edge here, otherwise cracks to the neighbouring face appear.
    reinsertDropped(ringStarts, nTotal) {
        const V = this.V, N = this.N;
        const used = new Uint8Array(nTotal);
        for (let h = 0; h < V.length; h++) used[V[h]] = 1;
        const bnd = new Map(); // boundary half-edge a->b -> h
        const K = 1 << 22;
        for (let h = 0; h < V.length; h++) if (N[h] < 0) bnd.set(V[h] * K + V[h - h % 3 + (h % 3 + 1) % 3], h);
        for (let r = 0; r < ringStarts.length - 1; r++) {
            const s = ringStarts[r], n = ringStarts[r + 1] - s;
            let first = -1;
            for (let i = 0; i < n; i++) if (used[s + i]) { first = i; break; }
            if (first < 0) continue;
            for (let k = 0; k < n; k++) {
                const i = (first + k) % n;
                if (!used[s + i]) continue;
                // run of missing points after i
                const miss = [];
                let j = (i + 1) % n;
                while (!used[s + j] && miss.length < n) { miss.push(s + j); j = (j + 1) % n; }
                if (!miss.length) continue;
                const p = s + i, q = s + j;
                let h = bnd.get(p * K + q), list = miss;
                if (h === undefined) { h = bnd.get(q * K + p); list = miss.slice().reverse(); }
                if (h === undefined) continue;
                let t = (h / 3) | 0, e = h % 3;
                for (const m of list) {
                    this.splitEdge(t, e, m);
                    used[m] = 1;
                    // remaining edge (m -> end) is at index 0 in the new triangle
                    t = this.count - 1; e = 0;
                }
            }
        }
    }
    flip(t, i) {
        const V = this.V, N = this.N, C = this.C, b = 3 * t;
        const a = V[b + i], bb = V[b + (i + 1) % 3], c = V[b + (i + 2) % 3];
        const u = N[b + i];
        const nBC = N[b + (i + 1) % 3], nCA = N[b + (i + 2) % 3], cBC = C[b + (i + 1) % 3], cCA = C[b + (i + 2) % 3];
        const j = this.edgeIndex(u, bb, a);
        const ub = 3 * u, d = V[ub + (j + 2) % 3];
        const nAD = N[ub + (j + 1) % 3], nDB = N[ub + (j + 2) % 3], cAD = C[ub + (j + 1) % 3], cDB = C[ub + (j + 2) % 3];
        this.set(t, a, d, c, nAD, u, nCA, cAD, 0, cCA);
        this.set(u, d, bb, c, nDB, nBC, t, cDB, cBC, 0);
        this.replaceNb(nAD, a, d, t);
        this.replaceNb(nBC, bb, c, u);
    }
    // Checks edge i of t (opposite corner V[t, i+2]) and flips recursively
    legalize(stack) {
        const V = this.V, N = this.N, C = this.C;
        let guard = 0;
        while (stack.length && guard++ < 100000) {
            const i = stack.pop(), t = stack.pop();
            const h = 3 * t + i;
            if (C[h] !== 0) continue;
            const u = N[h];
            if (u < 0) continue;
            const a = V[h], b = V[3 * t + (i + 1) % 3], c = V[3 * t + (i + 2) % 3];
            const j = this.edgeIndex(u, b, a);
            if (j < 0) continue;
            const d = V[3 * u + (j + 2) % 3];
            if (this.incircle(a, b, c, d) <= 0) continue;
            if (!this.ccw(a, d, c) || !this.ccw(d, b, c)) continue;
            this.flip(t, i);
            // new triangles: t = (a,d,c), u = (d,b,c); check outer edges opposite c
            stack.push(t, 0, u, 0);
        }
    }
    delaunay() {
        const stack = [];
        const n = this.count;
        for (let t = 0; t < n; t++) for (let i = 0; i < 3; i++) if (this.C[3 * t + i] === 0 && this.N[3 * t + i] > t) stack.push(t, i);
        // Lawson: legalize checks every edge against the opposite corner
        const V = this.V, N = this.N, C = this.C;
        let guard = 0;
        while (stack.length && guard++ < 200000) {
            const i = stack.pop(), t = stack.pop();
            const h = 3 * t + i;
            if (C[h] !== 0) continue;
            const u = N[h];
            if (u < 0) continue;
            const a = V[h], b = V[3 * t + (i + 1) % 3], c = V[3 * t + (i + 2) % 3];
            const j = this.edgeIndex(u, b, a);
            if (j < 0) continue;
            const d = V[3 * u + (j + 2) % 3];
            if (this.incircle(a, b, c, d) <= 0) continue;
            if (!this.ccw(a, d, c) || !this.ccw(d, b, c)) continue;
            this.flip(t, i);
            stack.push(t, 0, t, 2, u, 0, u, 1);
        }
    }
    // Split edge i of t at new corner m. Returns the affected triangles.
    splitEdge(t, i, m) {
        const V = this.V, N = this.N, C = this.C, b = 3 * t;
        const a = V[b + i], bb = V[b + (i + 1) % 3], c = V[b + (i + 2) % 3];
        const u = N[b + i], cAB = C[b + i];
        const nBC = N[b + (i + 1) % 3], nCA = N[b + (i + 2) % 3], cBC = C[b + (i + 1) % 3], cCA = C[b + (i + 2) % 3];
        const t2 = this.count;
        V.push(0, 0, 0); N.push(0, 0, 0); C.push(0, 0, 0);
        if (u >= 0) {
            const j = this.edgeIndex(u, bb, a), ub = 3 * u, d = V[ub + (j + 2) % 3];
            const nAD = N[ub + (j + 1) % 3], nDB = N[ub + (j + 2) % 3], cAD = C[ub + (j + 1) % 3], cDB = C[ub + (j + 2) % 3];
            const u2 = this.count;
            V.push(0, 0, 0); N.push(0, 0, 0); C.push(0, 0, 0);
            this.set(t, a, m, c, u2, t2, nCA, cAB, 0, cCA);
            this.set(t2, m, bb, c, u, nBC, t, cAB, cBC, 0);
            this.set(u, bb, m, d, t2, u2, nDB, cAB, 0, cDB);
            this.set(u2, m, a, d, t, nAD, u, cAB, cAD, 0);
            this.replaceNb(nBC, bb, c, t2);
            this.replaceNb(nAD, a, d, u2);
            return [t, 2, t2, 1, u, 2, u2, 1];
        }
        this.set(t, a, m, c, -1, t2, nCA, cAB, 0, cCA);
        this.set(t2, m, bb, c, -1, nBC, t, cAB, cBC, 0);
        this.replaceNb(nBC, bb, c, t2);
        return [t, 2, t2, 1];
    }
    splitTri(t, m) {
        const V = this.V, N = this.N, C = this.C, b = 3 * t;
        const a = V[b], bb = V[b + 1], c = V[b + 2];
        const nAB = N[b], nBC = N[b + 1], nCA = N[b + 2], cAB = C[b], cBC = C[b + 1], cCA = C[b + 2];
        const t2 = this.count, t3 = t2 + 1;
        V.push(0, 0, 0, 0, 0, 0); N.push(0, 0, 0, 0, 0, 0); C.push(0, 0, 0, 0, 0, 0);
        this.set(t, a, bb, m, nAB, t2, t3, cAB, 0, 0);
        this.set(t2, bb, c, m, nBC, t3, t, cBC, 0, 0);
        this.set(t3, c, a, m, nCA, t, t2, cCA, 0, 0);
        this.replaceNb(nBC, bb, c, t2);
        this.replaceNb(nCA, c, a, t3);
        return [t, 0, t2, 0, t3, 0];
    }
}

// --- Face tessellator ---

export class Tessellator {
    constructor(step, angleUnit = 1) {
        this.step = step;
        this.geo = new GeometryBuilder(step, angleUnit);
        this.edgeCache = new Map();
    }

    // 3D points of an EDGE_CURVE in edge direction (start vertex -> end vertex)
    edgePoints(e, defl, ang) {
        const key = e.id * 64 + Math.round(Math.log2(defl) * 2) + 32;
        let pts = this.edgeCache.get(key);
        if (pts) return pts;
        const geo = this.geo;
        const [, v1, v2, geomRef, sameSense] = e.args;
        const P1 = geo.point(v1), P2 = geo.point(v2);
        const curve = geo.curve(geomRef);
        if (curve.kind === 'line') {
            pts = [P1, P2];
            pts.ts = [0, 1];
            pts.f = t => [P1[0] + (P2[0] - P1[0]) * t, P1[1] + (P2[1] - P1[1]) * t, P1[2] + (P2[2] - P1[2]) * t];
        } else {
            const closedLoop = v1.id === v2.id || dist(P1, P2) < 1e-9 * (1 + len(P1));
            let ta, tb;
            const per = curve.period || (curve.closed ? curve.t1 - curve.t0 : 0);
            if (curve.period) {
                ta = curve.closest(P1);
                tb = curve.closest(P2);
                const P = curve.period;
                if (sameSense !== false) {
                    tb = ta + (((tb - ta) % P) + P) % P;
                    if (closedLoop && tb - ta < P * 0.5) tb = ta + P;
                } else {
                    tb = ta - (((ta - tb) % P) + P) % P;
                    if (closedLoop && ta - tb < P * 0.5) tb = ta - P;
                }
            } else if (closedLoop && (per || curve.t1 > curve.t0)) {
                // Edge with identical start/end vertex: traverse the whole curve – even
                // if the curve (e.g. B-spline) is not marked as closed
                ta = sameSense !== false ? curve.t0 : curve.t1;
                tb = sameSense !== false ? curve.t1 : curve.t0;
            } else {
                ta = curve.closest(P1);
                tb = curve.closest(P2);
            }
            const ts = sampleParams(curve, ta, tb, defl, ang);
            pts = ts.map(t => curve.eval(t));
            pts[0] = P1;
            pts[pts.length - 1] = P2;
            pts.ts = ts;
            pts.f = t => curve.eval(t);
        }
        this.edgeCache.set(key, pts);
        return pts;
    }

    loopPoints(loopRef, defl, ang) {
        const l = this.step.get(loopRef);
        if (l.type === 'POLY_LOOP') return l.args[1].map(r => this.geo.point(r));
        if (l.type !== 'EDGE_LOOP') return null;
        const out = [], segs = [];
        for (const oeRef of l.args[1]) {
            let oe = this.step.get(oeRef), forward = true;
            while (oe.type === 'ORIENTED_EDGE') {
                if (oe.args[4] === false) forward = !forward;
                oe = this.step.get(oe.args[3]);
            }
            if (oe.type !== 'EDGE_CURVE') throw new Error('Edge type not supported: ' + oe.type);
            const pts = this.edgePoints(oe, defl, ang);
            const ts = pts.ts;
            if (forward) {
                for (let i = 0; i < pts.length - 1; i++) { out.push(pts[i]); segs.push(ts && { f: pts.f, t0: ts[i], t1: ts[i + 1] }); }
            } else {
                for (let i = pts.length - 1; i > 0; i--) { out.push(pts[i]); segs.push(ts && { f: pts.f, t0: ts[i], t1: ts[i - 1] }); }
            }
        }
        out.segs = segs;   // per point i: curve piece to the next point (for densification)
        return out;
    }

    /**
     * Tessellates a face. Returns { positions, normals, indices } (local indices) or null.
     */
    face(faceId, defl, ang) {
        // negative ID = use the face reversed (void shell, ORIENTED_FACE)
        const reversed = faceId < 0;
        const f = this.step.get(Math.abs(faceId));
        if (!f || (f.type !== 'ADVANCED_FACE' && f.type !== 'FACE_SURFACE')) return null;
        const [, bounds, surfRef, sameSense] = f.args;
        const surf = this.geo.surface(surfRef);
        // Bounds are oriented relative to the surface itself (sameSense only); the reversal by
        // the shell (void) only affects the output (triangle winding, normals)
        const loopFlip = sameSense === false;
        const flip = loopFlip !== reversed;

        // --- Bounds in 3D ---
        const loops = [];
        let discarded = false;   // a real (non-point) bound was discarded as degenerate
        for (const bRef of bounds) {
            const b = this.step.get(bRef);
            let pts = this.loopPoints(b.args[1], defl, ang);
            if (!pts) continue;
            if (!surf.isPlane && pts.segs) pts = densifyForSurface(pts, pts.segs, surf, defl);
            const hint = pts.uvHint || null;
            if (b.args[2] === false) pts.reverse();
            if (loopFlip) pts.reverse();
            pts = dedupe3(pts, defl * 1e-3);
            if (pts.length < 2) continue;
            // bound degenerated to a point (pole, e.g. apex of a spline cone surface): not a bound
            if (extent3(pts) < defl * 0.01) { if (extent3(pts) > 0) discarded = true; continue; }
            loops.push({ p3: pts, outer: b.type === 'FACE_OUTER_BOUND', hint });
        }

        // --- Projection into parameter space ---
        const uP = surf.uPeriod, vP = surf.vPeriod;
        for (const L of loops) this.projectLoop(surf, L, uP, vP);
        const valid = loops.filter(L => L.uv.length >= 2);

        let rings; // [{uv: [[u,v]], p3: [[x,y,z]|null], c: [constraint per edge i->i+1]}]
        if (valid.length === 0) {
            // Bounds present but too small for the resolution: omit the face instead of
            // generating the whole underlying surface (e.g. a complete torus)
            if (discarded) return null;
            const dom = surf.domain && surf.domain();
            if (!dom) return null;
            rings = [rectRing(surf, dom)];
        } else {
            rings = this.buildRings(surf, valid, uP, vP);
        }
        if (!rings || rings.length === 0) return null;

        // --- Scaling (uv approximately isometric) ---
        let su = 1, sv = 1;
        if (!surf.isPlane) {
            let cu = 0, cv = 0, n = 0;
            for (const p of rings[0].uv) { cu += p[0]; cv += p[1]; n++; }
            const d = surf.evalD(cu / n, cv / n);
            su = len(d.du) || 1; sv = len(d.dv) || 1;
            if (!isFinite(su) || su < 1e-12) su = 1;
            if (!isFinite(sv) || sv < 1e-12) sv = 1;
        }

        // --- Triangulation ---
        // Coarse sampling can make a bound cross itself or other bounds
        // (edges running close together, chords deviate by up to defl) -> earcut returns
        // garbage, the parity fallback then fills e.g. a hole instead of the ring. In that case clean
        // up the polygon (polygon-clipping, nonzero rule) and only then triangulate.
        let repaired = false;
        if (!rings.multi && ringsCross(rings)) {
            const fixed = repairRings(rings);
            if (fixed) { rings = fixed; repaired = true; }
        }
        const triangulate = rings => {
            const U = [], Vv = [], X = [], Y = [], P3 = [];
            const ringEdges = new Map();
            const K = 1 << 22;
            const ringStarts = [], ringOuter = [];
            const tris = [];
            // one earcut triangulation per polygon (outer ring + holes); multiple polygons only
            // after cutting out periodic holes (clipBand)
            for (const poly of rings.multi || [rings]) {
                const base = U.length, flat = [], holes = [];
                for (let r = 0; r < poly.length; r++) {
                    const R = poly[r];
                    if (r > 0) holes.push(U.length - base);
                    ringStarts.push(U.length);
                    ringOuter.push(r === 0);
                    const start = U.length, n = R.uv.length;
                    for (let i = 0; i < n; i++) {
                        U.push(R.uv[i][0]); Vv.push(R.uv[i][1]);
                        X.push(R.uv[i][0] * su); Y.push(R.uv[i][1] * sv);
                        flat.push(R.uv[i][0] * su, R.uv[i][1] * sv);
                        P3.push(R.p3[i]);
                    }
                    for (let i = 0; i < n; i++) {
                        const a = start + i, b = start + (i + 1) % n;
                        const key = a < b ? a * K + b : b * K + a;
                        ringEdges.set(key, R.c[i]);
                    }
                }
                for (const t of earcut(flat, holes.length ? holes : null, 2)) tris.push(t + base);
            }
            if (tris.length === 0) return null;

            let mesh = new TriMesh(X, Y);
            mesh.build(tris, ringEdges, K);
            mesh.reinsertDropped([...ringStarts, U.length], U.length);
            // earcut drops exactly collinear boundary points (circles on cylinder/cone/sphere are
            // straight lines in uv space); together with holes this creates edges across boundary points.
            // Invalid result -> robust constrained Delaunay triangulation (exact predicates).
            const triOk = mesh.isValid(ringStarts, U.length);
            if (!triOk) {
                const cdt = constrainedTriangulation(X, Y, ringStarts, U.length, ringOuter);
                if (cdt && cdt.length) {
                    mesh = new TriMesh(X, Y);
                    mesh.build(cdt, ringEdges, K);
                }
            }
            mesh.delaunay();
            return { U, Vv, X, Y, P3, mesh, tris };
        };
        let T = triangulate(rings);
        // Safety net: triangle area must match the area of the boundary polygon
        if (!repaired && !rings.multi && (!T || !areaMatches(T, rings, su, sv))) {
            const fixed = repairRings(rings);
            if (fixed) { rings = fixed; repaired = true; T = triangulate(rings) || T; }
        }
        if (!T) return null;
        const { U, Vv, X, Y, P3 } = T;
        let { mesh } = T;

        const nBoundary = U.length;
        const normals = [];
        const nrm = (u, v) => surf.normal(u, v);

        if (!surf.isPlane) {
            const pts = P3; // index -> 3D point (boundary points set, interior ones are added)
            for (let i = 0; i < nBoundary; i++) {
                if (!pts[i]) pts[i] = surf.eval(U[i], Vv[i]);
                normals[i] = nrm(U[i], Vv[i]);
            }
            this.refine(mesh, surf, U, Vv, X, Y, pts, normals, su, sv, defl, ang);
        }

        // --- Output ---
        const nv = U.length;
        const positions = new Float32Array(nv * 3), outN = new Float32Array(nv * 3);
        const pn = surf.isPlane ? surf.normal() : null;
        const s = flip ? -1 : 1;
        for (let i = 0; i < nv; i++) {
            let p = P3[i];
            if (!p) p = P3[i] = surf.eval(U[i], Vv[i]);
            positions[i * 3] = p[0]; positions[i * 3 + 1] = p[1]; positions[i * 3 + 2] = p[2];
            const n = pn || normals[i] || nrm(U[i], Vv[i]);
            outN[i * 3] = n[0] * s; outN[i * 3 + 1] = n[1] * s; outN[i * 3 + 2] = n[2] * s;
        }
        const V = mesh.V, nt = V.length / 3;
        const indices = new Uint32Array(V.length);
        let k = 0;
        for (let t = 0; t < nt; t++) {
            const a = V[3 * t], b = V[3 * t + 1], c = V[3 * t + 2];
            if (a === b || b === c || a === c) continue;
            if (flip) { indices[k++] = a; indices[k++] = c; indices[k++] = b; }
            else { indices[k++] = a; indices[k++] = b; indices[k++] = c; }
        }
        return { positions, normals: outN, indices: k === indices.length ? indices : indices.slice(0, k) };
    }

    projectLoop(surf, L, uP, vP) {
        const n = L.p3.length;
        const uv = new Array(n), freeU = new Array(n), freeV = new Array(n);
        let guess = null;
        for (let i = 0; i < n; i++) {
            const g = (L.hint && L.hint.get(L.p3[i])) || surf.project(L.p3[i], guess);
            uv[i] = [g[0], g[1]];
            guess = g;
            const d = surf.evalD(g[0], g[1]);
            const lu = len(d.du), lv = len(d.dv);
            freeU[i] = lu < 1e-7 * lv;
            freeV[i] = lv < 1e-7 * lu;
        }
        // Start at a regular point
        let s = 0;
        while (s < n && (freeU[s] || freeV[s])) s++;
        if (s === n) { L.uv = []; return; }
        const rot = a => a.slice(s).concat(a.slice(0, s));
        let p3 = rot(L.p3), UV = rot(uv), FU = rot(freeU), FV = rot(freeV);

        const driftU = unwrapCoord(UV, FU, 0, uP);
        const driftV = unwrapCoord(UV, FV, 1, vP);

        // Duplicate singular points (pole, cone apex, degenerate spline edge):
        // incoming and outgoing parameter value
        const outUV = [], outP = [];
        for (let i = 0; i < n; i++) {
            if (!FU[i] && !FV[i]) { outUV.push(UV[i]); outP.push(p3[i]); continue; }
            if (FU[i] && FV[i]) continue;
            const c = FU[i] ? 0 : 1;
            const prev = outUV[outUV.length - 1];
            let j = i + 1;
            while (j < n && (FU[j] || FV[j])) j++;
            let nextVal;
            if (j < n) nextVal = UV[j][c];
            else nextVal = UV[0][c] + (c === 0 ? driftU : driftV);
            const a = [0, 0], b = [0, 0];
            a[c] = prev[c]; a[1 - c] = UV[i][1 - c];
            b[c] = nextVal; b[1 - c] = UV[i][1 - c];
            outUV.push(a); outP.push(p3[i]);
            if (Math.abs(nextVal - prev[c]) > 1e-9) { outUV.push(b); outP.push(p3[i]); }
        }
        L.uv = outUV; L.p3 = outP;
        L.kU = uP ? Math.round(driftU / uP) : 0;
        L.kV = vP ? Math.round(driftV / vP) : 0;
    }

    // Creates the earcut rings (first = outer bound) incl. seam handling
    buildRings(surf, loops, uP, vP) {
        const wrapU = loops.filter(L => L.kU !== 0), wrapV = loops.filter(L => L.kV !== 0);
        if (wrapU.length && wrapV.length) {
            // Bounds wrapping in both directions (e.g. torus) – discard outer bound, rest as usual
            throw new Error('Face with seams in u and v not supported');
        }
        if (!wrapU.length && !wrapV.length) {
            let outer = loops.find(L => L.outer);
            const areas = loops.map(L => Math.abs(area2(L.uv)));
            if (!outer || loops.filter(L => L.outer).length !== 1) {
                let bi = 0;
                for (let i = 1; i < loops.length; i++) if (areas[i] > areas[bi]) bi = i;
                outer = loops[bi];
            }
            const rings = [mkRing(outer.uv, outer.p3, 2)];
            const [umin, umax] = range(outer.uv, 0), [vmin, vmax] = range(outer.uv, 1);
            for (const L of loops) {
                if (L === outer) continue;
                if (uP) shiftInto(L.uv, 0, (umin + umax) / 2, uP);
                if (vP) shiftInto(L.uv, 1, (vmin + vmax) / 2, vP);
                rings.push(mkRing(L.uv, L.p3, 2));
            }
            return rings;
        }

        // Bounds that wrap once around the periodic direction.
        // c = wrapping coordinate, o = the other one. A bound running in +c has its material
        // on the left: for c=u above (larger v), for c=v on the side of smaller u.
        // "lower" = bound with material on the side of larger o, "upper" = the opposite.
        const mirror = wrapV.length > 0;
        const c = mirror ? 1 : 0;           // wrapping coordinate
        const P = mirror ? vP : uP;
        const W = mirror ? wrapV : wrapU;
        const kOf = L => (mirror ? -L.kV : L.kU); // >0: material on the "upper" side
        const lower = W.filter(L => kOf(L) > 0), upper = W.filter(L => kOf(L) < 0);
        const o = 1 - c;
        lower.sort((a, b) => avg(a.uv, o) - avg(b.uv, o));
        upper.sort((a, b) => avg(a.uv, o) - avg(b.uv, o));
        const L0 = lower[0], H0 = upper[0];
        // Cut line: place it in the largest gap between the inner bounds (holes) so that
        // no hole is cut by the seam; never exactly on a boundary point (circle corner points
        // typically lie on the seam and would otherwise be assigned to the wrong period).
        const ref = (L0 || H0).uv;
        let cut = ref.length > 1 ? (ref[0][c] + ref[1][c]) / 2 : ref[0][c];
        const holes = loops.filter(L => L.kU === 0 && L.kV === 0);
        if (holes.length) {
            // occupied intervals (mod P) relative to cut
            const iv = holes.map(L => {
                const [a, b] = range(L.uv, c);
                const s0 = (((a - cut) % P) + P) % P;
                return [s0, s0 + (b - a)];
            }).sort((x, y) => x[0] - y[0]);
            // intervals extending past the end of the period also cover the start
            let end = iv[0][1];
            for (const [, e] of iv) end = Math.max(end, e - P);
            let bestGap = -1, bestAt = 0;
            for (let i = 1; i <= iv.length; i++) {
                const next = i < iv.length ? iv[i][0] : iv[0][0] + P;
                if (next - end > bestGap) { bestGap = next - end; bestAt = (end + next) / 2; }
                if (i < iv.length) end = Math.max(end, iv[i][1]);
            }
            if (bestGap > 0) cut = cut + bestAt;
        }

        let ring;
        const dom = surf.domain ? surf.domain() : null;
        const lim = dom ? (mirror ? [dom[0], dom[1]] : [dom[2], dom[3]]) : [-Infinity, Infinity];
        // running direction of a wrapping bound in the periodic coordinate
        const dirOf = L => Math.sign(mirror ? L.kV : L.kU) || 1;
        // If the other coordinate is periodic too (torus), shift the second bound so that
        // the band lies between the bounds (material side), not across the rest
        const Po = mirror ? uP : vP;
        if (L0 && H0 && Po) {
            const a = avg(L0.uv, o), b = avg(H0.uv, o);
            const k = Math.floor((b - a) / Po);
            const shift = -k * Po + (b - k * Po <= a ? Po : 0);
            if (shift) for (const p of H0.uv) p[o] += shift;
        }
        if (L0 && H0) {
            const dA = dirOf(L0), dB = dirOf(H0);
            const a = openLoop(L0, c, cut, P, dA), b = openLoop(H0, c, cut + dA * P, P, dB);
            ring = { uv: a.uv.concat(b.uv), p3: a.p3.concat(b.p3), c: [] };
            for (let i = 0; i < a.uv.length - 1; i++) ring.c.push(2);
            ring.c.push(1);
            for (let i = 0; i < b.uv.length - 1; i++) ring.c.push(2);
            ring.c.push(1);
        } else if (L0) {
            // material on one side up to the domain limit (pole)
            const top = lim[1];
            if (!isFinite(top)) throw new Error('Open periodic bound');
            const dA = dirOf(L0);
            const a = openLoop(L0, c, cut, P, dA);
            ring = closeAt(a, c, cut, top);
        } else {
            const bot = lim[0];
            if (!isFinite(bot)) throw new Error('Open periodic bound');
            const dB = dirOf(H0);
            const b = openLoop(H0, c, cut, P, dB);
            ring = closeAt(b, c, cut, bot);
        }
        const rings = [ring];
        const holeLoops = loops.filter(L => L.kU === 0 && L.kV === 0);
        for (const L of holeLoops) shiftInto(L.uv, c, cut + P / 2, P);
        const eps = P * 1e-9;
        const crossing = holeLoops.some(L => {
            const [a, b] = range(L.uv, c);
            return a < cut - eps || b > cut + P + eps;
        });
        if (!crossing) {
            for (const L of holeLoops) rings.push(mkRing(L.uv, L.p3, 2));
            return rings;
        }
        // Holes cover the whole circumference, every seam cut line cuts through one
        // (e.g. staggered slots in a ring): region = band minus holes (periodically
        // continued) via polygon boolean operation. Result: possibly several polygons.
        return clipBand(ring, holeLoops, c, cut, P);
    }

    refine(mesh, surf, U, Vv, X, Y, P3, normals, su, sv, defl, ang) {
        const V = mesh.V, C = mesh.C;
        const cosA = Math.cos(ang);
        const defl2 = defl * defl;
        const minLen2 = defl2 * 0.01;
        const K = 1 << 22;
        const edgeOk = new Map(); // edges already checked as sufficient

        // Already occupied uv positions: Delaunay flips can restore a split edge;
        // splitting it again would create duplicate points at the same position
        // (endless loop up to the vertex limit, e.g. 120,000 triangles on a small sphere).
        const uvKey = (u, v) => Math.round(u * su * 1e6 / defl) + ':' + Math.round(v * sv * 1e6 / defl);
        const uvSeen = new Set();
        for (let i = 0; i < U.length; i++) uvSeen.add(uvKey(U[i], Vv[i]));

        const addVertex = (u, v) => {
            const i = U.length;
            U.push(u); Vv.push(v); X.push(u * su); Y.push(v * sv);
            P3.push(surf.eval(u, v));
            normals.push(surf.normal(u, v));
            return i;
        };
        const edgeNeeds = (a, b) => {
            const key = a < b ? a * K + b : b * K + a;
            if (edgeOk.has(key)) return 0;
            const pa = P3[a], pb = P3[b];
            const l2 = dist2(pa, pb);
            let need = 0;
            if (l2 > minLen2) {
                const pm = surf.eval((U[a] + U[b]) / 2, (Vv[a] + Vv[b]) / 2);
                const mx = (pa[0] + pb[0]) / 2 - pm[0], my = (pa[1] + pb[1]) / 2 - pm[1], mz = (pa[2] + pb[2]) / 2 - pm[2];
                if (mx * mx + my * my + mz * mz > defl2) need = l2;
                else if (dot(normals[a], normals[b]) < cosA) need = l2;
            }
            if (!need) edgeOk.set(key, 1);
            return need;
        };

        const queue = [];
        for (let t = 0; t < mesh.count; t++) queue.push(t);
        const stack = [];
        let guard = 0;
        while (queue.length && U.length < MAX_FACE_VERTS && guard++ < 400000) {
            const t = queue.pop();
            const b = 3 * t;
            let best = -1, bestL = 0;
            for (let i = 0; i < 3; i++) {
                if (C[b + i] === 2) continue;
                const need = edgeNeeds(V[b + i], V[b + (i + 1) % 3]);
                if (need > bestL) { bestL = need; best = i; }
            }
            let touched;
            if (best >= 0) {
                const a = V[b + best], c = V[b + (best + 1) % 3];
                const um = (U[a] + U[c]) / 2, vm = (Vv[a] + Vv[c]) / 2;
                const km = uvKey(um, vm);
                if (uvSeen.has(km)) {
                    edgeOk.set(a < c ? a * K + c : c * K + a, 1);
                    queue.push(t);
                    continue;
                }
                // only split if all resulting triangles are valid (no slivers)
                const mx = um * su, my = vm * sv;
                const cOpp = V[b + (best + 2) % 3];
                const nb = mesh.N[b + best];
                let ok = ccwPt(X, Y, a, mx, my, cOpp, true) && ccwPt(X, Y, c, mx, my, cOpp, false);
                if (ok && nb >= 0) {
                    const j = mesh.edgeIndex(nb, c, a);
                    if (j < 0) ok = false;
                    else {
                        const dOpp = V[3 * nb + (j + 2) % 3];
                        ok = ccwPt(X, Y, c, mx, my, dOpp, true) && ccwPt(X, Y, a, mx, my, dOpp, false);
                    }
                }
                if (!ok) {
                    edgeOk.set(a < c ? a * K + c : c * K + a, 1);
                    queue.push(t);
                    continue;
                }
                uvSeen.add(km);
                const m = addVertex(um, vm);
                touched = mesh.splitEdge(t, best, m);
            } else {
                const a = V[b], c = V[b + 1], d = V[b + 2];
                const pa = P3[a], pc = P3[c], pd = P3[d];
                // Only split triangles whose smallest height is clearly above the tolerance –
                // otherwise the centroid converges towards a (fixed) boundary chord whose
                // deviation does not decrease by splitting.
                const area2x = len(cross(sub(pc, pa), sub(pd, pa)));
                const maxE = Math.sqrt(Math.max(dist2(pa, pc), dist2(pc, pd), dist2(pd, pa)));
                if (area2x < 4 * defl * maxE) continue;
                const uc = (U[a] + U[c] + U[d]) / 3, vc = (Vv[a] + Vv[c] + Vv[d]) / 3;
                const kc = uvKey(uc, vc);
                if (uvSeen.has(kc)) continue;
                uvSeen.add(kc);
                const pm = surf.eval(uc, vc);
                const cx = (pa[0] + pc[0] + pd[0]) / 3 - pm[0], cy = (pa[1] + pc[1] + pd[1]) / 3 - pm[1], cz = (pa[2] + pc[2] + pd[2]) / 3 - pm[2];
                if (cx * cx + cy * cy + cz * cz <= defl2) continue;
                if (!mesh.ccw(a, c, d)) continue;
                const m = addVertex(uc, vc);
                touched = mesh.splitTri(t, m);
            }
            stack.length = 0;
            for (let k = 0; k < touched.length; k++) stack.push(touched[k]);
            mesh.legalize(stack);
            for (let k = 0; k < touched.length; k += 2) queue.push(touched[k]);
            // flips may have changed neighbours – check neighbours again
            for (let k = 0; k < touched.length; k += 2) {
                const tt = touched[k];
                for (let i = 0; i < 3; i++) { const nb = mesh.N[3 * tt + i]; if (nb >= 0) queue.push(nb); }
            }
        }
    }
}

// --- Ring helpers ---

// Densify a bound for a curved surface: edges are sampled by their 3D shape,
// but often do not run straight in uv space (near poles, on splines, …). A boundary segment whose
// uv midpoint on the surface does not lie at the true curve midpoint is subdivided with true
// curve points – otherwise the uv bound cuts straight across the region (wrong triangles,
// endless refinement).
function densifyForSurface(pts, segs, surf, defl) {
    const n = pts.length;
    const uvCache = new Map();
    let guess = null;
    const uvOf = p => {
        let r = uvCache.get(p);
        if (!r) { r = surf.project(p, guess); uvCache.set(p, r); }
        guess = r;
        return r;
    };
    const tol2 = (defl * 0.5) ** 2;
    const out = [];
    const rec = (a, ta, b, tb, f, depth) => {
        if (depth > 8) return;
        const ua = uvOf(a), ub = uvOf(b);
        let u2 = ub[0], v2 = ub[1];
        if (surf.uPeriod) u2 = wrapNear(u2, ua[0], surf.uPeriod);
        if (surf.vPeriod) v2 = wrapNear(v2, ua[1], surf.vPeriod);
        const ps = surf.eval((ua[0] + u2) / 2, (ua[1] + v2) / 2);
        const tm = (ta + tb) / 2, pc = f(tm);
        // Deviation must exceed the tolerance AND 1 % of the segment length – otherwise numerical
        // noise of the spline projection splits down to the maximum depth at tiny tolerances
        const d2 = dist2(ps, pc);
        if (d2 <= tol2 || d2 <= 1e-4 * dist2(a, b)) return;
        rec(a, ta, pc, tm, f, depth + 1);
        out.push(pc);
        rec(pc, tm, b, tb, f, depth + 1);
    };
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n], s = segs[i];
        out.push(a);
        if (s) rec(a, s.t0, b, s.t1, s.f, 0);
    }
    // pass already computed uv values on to projectLoop (projection is expensive for splines)
    out.uvHint = uvCache;
    return out;
}

// Is triangle (p, m, o) or (m, p, o) with new point m=(mx,my) strictly counter-clockwise?
// (relative tolerance like TriMesh.ccw)
function ccwPt(X, Y, p, mx, my, o, pFirst) {
    const ax = pFirst ? X[p] : mx, ay = pFirst ? Y[p] : my;
    const bx = pFirst ? mx : X[p], by = pFirst ? my : Y[p];
    const cx = X[o], cy = Y[o];
    const or = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = (bx - ax) ** 2 + (by - ay) ** 2 + (cx - bx) ** 2 + (cy - by) ** 2 + (ax - cx) ** 2 + (ay - cy) ** 2;
    return or > 1e-9 * l;
}

// Triangulate rings (points X/Y, ring starts) with cdt2d (fallback only, slower)
function constrainedTriangulation(X, Y, ringStarts, n, ringOuter) {
    // merge exactly duplicate points (cdt2d expects unique points)
    const key = new Map(), rep = new Int32Array(n), pts = [], orig = [];
    for (let i = 0; i < n; i++) {
        const k = X[i] + ',' + Y[i];
        let u = key.get(k);
        if (u === undefined) { u = pts.length; key.set(k, u); pts.push([X[i], Y[i]]); orig.push(i); }
        rep[i] = u;
    }
    const edges = [];
    const starts = [...ringStarts, n];
    for (let r = 0; r < ringStarts.length; r++) {
        const s = starts[r], m = starts[r + 1] - s;
        for (let i = 0; i < m; i++) {
            const a = rep[s + i], b = rep[s + (i + 1) % m];
            if (a !== b) edges.push([a, b]);
        }
    }
    // Compute all triangles and determine inside/outside ourselves: otherwise cdt2d decides by
    // parity (every boundary edge toggles inside/outside) – with touching rings (hole at the
    // outer bound, boundary points used twice) whole regions flip (hole filled, ring empty).
    // Winding number of the centroid over all rings (outer bound and holes opposite) is robust.
    let all;
    try {
        all = cdt2d(pts, edges, { exterior: true });
    } catch {
        return null;
    }
    const sign = ringStarts.map((_, r) => {
        const a = signedArea(X, Y, starts[r], starts[r + 1]);
        return (a < 0 ? -1 : 1) * (ringOuter[r] ? 1 : -1);   // outer ring inside +1, hole inside −1
    });
    const cells = all.filter(([a, b, c]) => {
        const cx = (pts[a][0] + pts[b][0] + pts[c][0]) / 3, cy = (pts[a][1] + pts[b][1] + pts[c][1]) / 3;
        let w = 0;
        for (let r = 0; r < ringStarts.length; r++) w += sign[r] * windingAt(X, Y, starts[r], starts[r + 1], cx, cy);
        return w > 0;
    });
    const out = new Array(cells.length * 3);
    for (let i = 0; i < cells.length; i++) {
        out[i * 3] = orig[cells[i][0]];
        out[i * 3 + 1] = orig[cells[i][1]];
        out[i * 3 + 2] = orig[cells[i][2]];
    }
    return out;
}

function signedArea(X, Y, s0, s1) {
    let a = 0;
    for (let i = s0; i < s1; i++) {
        const j = i + 1 < s1 ? i + 1 : s0;
        a += X[i] * Y[j] - X[j] * Y[i];
    }
    return a / 2;
}

// Winding number of ring [s0, s1) around point (x, y)
function windingAt(X, Y, s0, s1, x, y) {
    let w = 0;
    for (let i = s0; i < s1; i++) {
        const j = i + 1 < s1 ? i + 1 : s0;
        const ay = Y[i], by = Y[j];
        if (ay <= y) {
            if (by > y && (X[j] - X[i]) * (y - ay) - (x - X[i]) * (by - ay) > 0) w++;
        } else if (by <= y && (X[j] - X[i]) * (y - ay) - (x - X[i]) * (by - ay) < 0) w--;
    }
    return w;
}

function extent3(pts) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
    return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
}

function dedupe3(pts, eps) {
    const e2 = eps * eps, out = [];
    for (const p of pts) if (!out.length || dist2(out[out.length - 1], p) > e2) out.push(p);
    while (out.length > 1 && dist2(out[0], out[out.length - 1]) <= e2) out.pop();
    return out;
}

// Unwraps a periodic coordinate continuously; returns the total drift of one round.
// At singular points the jump direction is chosen so that the bound
// runs counter-clockwise (material on the left).
function unwrapCoord(uv, free, c, period) {
    const n = uv.length, o = 1 - c;
    let prevIdx = 0, drift = 0;
    const step = (i, j, gapStart, gapEnd) => {
        // value of j relative to i (j follows i, possibly with singular points in between)
        let x = uv[j][c] + (j === 0 ? drift : 0);
        if (period) {
            x = wrapNear(x, uv[i][c], period);
            if (gapStart >= 0) {
                const so = uv[gapStart][o], oa = (uv[i][o] + uv[j][o]) / 2;
                const high = so > oa;
                // c=0 (u free, pole top/bottom): top -> du<0, bottom -> du>0
                // c=1 (v free, side right/left): right -> dv>0, left -> dv<0
                const wantPos = c === 0 ? !high : high;
                const d = x - uv[i][c];
                if (Math.abs(d) > 1e-9 && (d > 0) !== wantPos) x += wantPos ? period : -period;
            }
        }
        return x;
    };
    let gap = -1;
    for (let j = 1; j < n; j++) {
        if (free[j]) { if (gap < 0) gap = j; continue; }
        uv[j][c] = step(prevIdx, j, gap, j);
        prevIdx = j; gap = -1;
    }
    if (!period) return 0;
    // Closing step back to the start point
    const closeVal = step(prevIdx, 0, gap, 0);
    drift = closeVal - uv[0][c];
    return drift;
}

function area2(uv) {
    let a = 0;
    for (let i = 0, n = uv.length; i < n; i++) {
        const p = uv[i], q = uv[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}
function range(uv, c) {
    let mn = Infinity, mx = -Infinity;
    for (const p of uv) { if (p[c] < mn) mn = p[c]; if (p[c] > mx) mx = p[c]; }
    return [mn, mx];
}
function avg(uv, c) { let s = 0; for (const p of uv) s += p[c]; return s / uv.length; }
function shiftInto(uv, c, center, P) {
    const k = Math.round((avg(uv, c) - center) / P);
    if (k) for (const p of uv) p[c] -= k * P;
}
function mkRing(uv, p3, cons) {
    return { uv, p3, c: new Array(uv.length).fill(cons) };
}

// Band (opened outer ring between cut and cut+P) minus holes -> polygons [outer, ...holes]
function clipBand(ring, holeLoops, c, cut, P) {
    const keyOf = p => p[0].toFixed(9) + ',' + p[1].toFixed(9);
    const p3map = new Map();
    ring.uv.forEach((p, i) => { if (ring.p3[i]) p3map.set(keyOf(p), ring.p3[i]); });
    const clips = [];
    for (const L of holeLoops) {
        for (const k of [-1, 0, 1]) {
            const pts = L.uv.map((p, i) => {
                const q = [p[0], p[1]];
                q[c] += k * P;
                if (L.p3[i]) p3map.set(keyOf(q), L.p3[i]);   // periodic: same 3D point
                return q;
            });
            clips.push([pts]);
        }
    }
    let result;
    try {
        result = polygonClipping.difference([ring.uv.map(p => [p[0], p[1]])], ...clips);
    } catch (err) {
        throw new Error('Holes across the seam cannot be resolved: ' + err.message);
    }
    const eps = P * 1e-7;
    const onCut = x => Math.abs(x - cut) < eps || Math.abs(x - cut - P) < eps;
    const restore = collinearRestorer(p3map);
    const polys = result.map(poly => poly.map(r => {
        const pts = restore(r.slice(0, -1));   // rings are closed (first = last point)
        return {
            uv: pts,
            p3: pts.map(p => p3map.get(keyOf(p)) || null),
            c: pts.map((p, i) => (onCut(p[c]) && onCut(pts[(i + 1) % pts.length][c]) ? 1 : 2)),
        };
    })).filter(poly => poly.length && poly[0].uv.length >= 3);
    const out = polys[0] || [];
    out.multi = polys;
    return out;
}

// polygon-clipping removes exactly collinear points (e.g. a circle at constant v is a straight
// line in uv space) -> reinsert the original boundary points on every result edge
function collinearRestorer(p3map) {
    const cand = [];
    for (const k of p3map.keys()) { const [x, y] = k.split(',').map(Number); cand.push([x, y]); }
    return pts => {
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            out.push(a);
            const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
            if (l2 === 0) continue;
            const tol = 1e-9 * Math.sqrt(l2);
            const on = [];
            for (const q of cand) {
                const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2;
                if (t <= 1e-9 || t >= 1 - 1e-9) continue;
                if (Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / Math.sqrt(l2) > tol + 1e-12) continue;
                on.push([t, q]);
            }
            on.sort((x, y) => x[0] - y[0]);
            for (const [, q] of on) out.push(q);
        }
        return out;
    };
}

// Do boundary segments cross (of one ring with itself or of two rings)? Proper crossings
// (no touching at endpoints); segments distributed over a grid -> nearly linear.
function ringsCross(rings) {
    let n = 0;
    for (const R of rings) n += R.uv.length;
    if (n < 4) return false;
    const AX = new Float64Array(n), AY = new Float64Array(n), BX = new Float64Array(n), BY = new Float64Array(n);
    const RI = new Int32Array(n), II = new Int32Array(n), RN = new Int32Array(n);
    let k = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rings.forEach((R, r) => {
        const m = R.uv.length;
        for (let i = 0; i < m; i++, k++) {
            const a = R.uv[i], b = R.uv[(i + 1) % m];
            AX[k] = a[0]; AY[k] = a[1]; BX[k] = b[0]; BY[k] = b[1]; RI[k] = r; II[k] = i; RN[k] = m;
            minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]); minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1]);
        }
    });
    const G = Math.max(1, Math.ceil(Math.sqrt(n)));
    const cw = (maxX - minX) / G || 1, ch = (maxY - minY) / G || 1;
    const cells = new Map();
    for (let s = 0; s < n; s++) {
        const x0 = Math.min(G - 1, Math.floor((Math.min(AX[s], BX[s]) - minX) / cw)), x1 = Math.min(G - 1, Math.floor((Math.max(AX[s], BX[s]) - minX) / cw));
        const y0 = Math.min(G - 1, Math.floor((Math.min(AY[s], BY[s]) - minY) / ch)), y1 = Math.min(G - 1, Math.floor((Math.max(AY[s], BY[s]) - minY) / ch));
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            const key = x * G + y;
            let c = cells.get(key);
            if (!c) cells.set(key, c = []);
            c.push(s);
        }
    }
    const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    for (const c of cells.values()) {
        for (let i = 0; i < c.length; i++) {
            const s = c[i];
            for (let j = i + 1; j < c.length; j++) {
                const t = c[j];
                if (RI[s] === RI[t]) {   // adjacent segments of a ring share a point
                    const d = Math.abs(II[s] - II[t]);
                    if (d <= 1 || d === RN[s] - 1) continue;
                }
                const d1 = orient(AX[s], AY[s], BX[s], BY[s], AX[t], AY[t]), d2 = orient(AX[s], AY[s], BX[s], BY[s], BX[t], BY[t]);
                if (!((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))) continue;
                const d3 = orient(AX[t], AY[t], BX[t], BY[t], AX[s], AY[s]), d4 = orient(AX[t], AY[t], BX[t], BY[t], BX[s], BY[s]);
                if ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) return true;
            }
        }
    }
    return false;
}

// Clean up the boundary polygon: outer ring minus holes with polygon-clipping (self-intersections
// by the nonzero rule) -> valid, non-intersecting polygons. Boundary points keep their
// 3D points (watertight), new points appear only at crossings. Result like clipBand (multi).
function repairRings(rings) {
    const keyOf = p => p[0].toFixed(9) + ',' + p[1].toFixed(9);
    const p3map = new Map();
    for (const R of rings) R.uv.forEach((p, i) => { if (R.p3[i]) p3map.set(keyOf(p), R.p3[i]); });
    const ring = R => R.uv.map(p => [p[0], p[1]]);
    let result;
    try {
        result = polygonClipping.difference([ring(rings[0])], ...rings.slice(1).map(R => [ring(R)]));
    } catch {
        return null;
    }
    const restore = collinearRestorer(p3map);
    const polys = result.map(poly => poly.map(r => {
        const pts = restore(r.slice(0, -1));   // rings are closed (first = last point)
        return { uv: pts, p3: pts.map(p => p3map.get(keyOf(p)) || null), c: pts.map(() => 2) };
    })).filter(poly => poly.length && poly[0].uv.length >= 3);
    if (!polys.length) return null;
    const out = polys[0];
    out.multi = polys;
    return out;
}

// Does the area of the triangles match the area of the boundary polygon (outer ring minus holes)?
// If the triangulation flips (hole filled, ring empty, overlapping triangles), it deviates clearly.
function areaMatches(T, rings, su, sv) {
    const { X, Y } = T, V = T.mesh.V;
    let tri = 0;
    for (let t = 0; t < V.length; t += 3) {
        const a = V[t], b = V[t + 1], c = V[t + 2];
        tri += Math.abs((X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a])) / 2;
    }
    let poly = Math.abs(area2(rings[0].uv));
    for (let r = 1; r < rings.length; r++) poly -= Math.abs(area2(rings[r].uv));
    poly *= su * sv;
    if (!(poly > 0)) return true;   // no meaningful reference (e.g. holes larger than the bound)
    return Math.abs(tri - poly) <= 0.02 * poly;
}

// Opens a wrapping bound at coordinate cut: result runs from cut to cut + dir*P
function openLoop(L, c, cut, P, dir) {
    const n = L.uv.length;
    const drift = dir * P;
    // Extended sequence: points 0..n-1, then 0..n-1 + drift
    const val = i => L.uv[i % n][c] + (i >= n ? drift : 0);
    // Shift the loop start value so that the cut lies in the first round
    const k = Math.floor((dir * (L.uv[0][c] - cut)) / P);
    const shift = -dir * k * P;
    const target = cut + drift; // value to cross (after shifting)
    let i0 = -1;
    for (let i = 0; i < 2 * n - 1; i++) {
        const a = val(i) + shift, b = val(i + 1) + shift;
        if (dir > 0 ? (a < target && b >= target) : (a > target && b <= target)) { i0 = i; break; }
    }
    if (i0 < 0) {
        // No cut found: return unchanged
        return { uv: L.uv.map(p => p.slice()), p3: L.p3.slice() };
    }
    const a = val(i0) + shift, b = val(i0 + 1) + shift;
    const f = b !== a ? (target - a) / (b - a) : 0;
    const pa = L.uv[i0 % n], pb = L.uv[(i0 + 1) % n];
    const o = 1 - c;
    const xo = pa[o] + (pb[o] - pa[o]) * f;
    const qa = L.p3[i0 % n], qb = L.p3[(i0 + 1) % n];
    const X3 = [qa[0] + (qb[0] - qa[0]) * f, qa[1] + (qb[1] - qa[1]) * f, qa[2] + (qb[2] - qa[2]) * f];
    const uv = [], p3 = [];
    const push = (cv, ov, p) => { const q = [0, 0]; q[c] = cv; q[o] = ov; uv.push(q); p3.push(p); };
    push(cut, xo, X3);
    // only points strictly between the two cut points (rounding at the seam could otherwise
    // sort a point in shifted by one period -> backward spike in the ring)
    const eps = P * 1e-9;
    const lo = Math.min(cut, target) + eps, hi = Math.max(cut, target) - eps;
    for (let i = i0 + 1; i <= i0 + n; i++) {
        const v = val(i) + shift - drift;
        if (v <= lo || v >= hi) continue;
        push(v, L.uv[i % n][o], L.p3[i % n]);
    }
    push(target, xo, X3);
    // remove duplicate end points
    const outUV = [], outP = [];
    for (let i = 0; i < uv.length; i++) {
        const prev = outUV[outUV.length - 1];
        if (prev && Math.abs(prev[0] - uv[i][0]) < 1e-12 && Math.abs(prev[1] - uv[i][1]) < 1e-12) continue;
        outUV.push(uv[i]); outP.push(p3[i]);
    }
    return { uv: outUV, p3: outP };
}

// Closes an opened bound via a domain limit (pole / surface edge)
function closeAt(a, c, cut, limit) {
    const o = 1 - c;
    const uv = a.uv.slice(), p3 = a.p3.slice(), cons = [];
    for (let i = 0; i < uv.length - 1; i++) cons.push(2);
    const endC = uv[uv.length - 1][c];
    const n = Math.max(2, Math.ceil(Math.abs(endC - cut) / (Math.PI / 8)));
    // back along the limit
    for (let k = 0; k <= n; k++) {
        const q = [0, 0];
        q[c] = endC + (cut - endC) * k / n;
        q[o] = limit;
        uv.push(q); p3.push(null); cons.push(1);
    }
    cons.push(1);
    return { uv, p3, c: cons };
}

function rectRing(surf, dom) {
    const [u0, u1, v0, v1] = dom;
    const uv = [], n = 8;
    for (let i = 0; i < n; i++) uv.push([u0 + (u1 - u0) * i / n, v0]);
    for (let i = 0; i < n; i++) uv.push([u1, v0 + (v1 - v0) * i / n]);
    for (let i = 0; i < n; i++) uv.push([u1 - (u1 - u0) * i / n, v1]);
    for (let i = 0; i < n; i++) uv.push([u0, v1 - (v1 - v0) * i / n]);
    return { uv, p3: uv.map(() => null), c: uv.map(() => 1) };
}

// Boundary edges of a face (edges belonging to only one triangle) with the triangle's running direction,
// as pairs of local vertex indices – for the orientation matching of neighbouring faces (orientFaces
// in step-importer). Note: direction from the face normal instead of the triangle was worse (spline data).
export function boundaryEdges(indices, nv) {
    const seen = new Map();   // undirected key -> directed edge (a * nv + b), or -1 if used more than once
    for (let i = 0; i < indices.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const a = indices[i + k], b = indices[i + (k + 1) % 3];
            if (a === b) continue;
            const key = a < b ? a * nv + b : b * nv + a;
            seen.set(key, seen.has(key) ? -1 : a * nv + b);
        }
    }
    const out = [];
    for (const d of seen.values()) if (d >= 0) out.push(Math.floor(d / nv), d % nv);
    return out;
}
