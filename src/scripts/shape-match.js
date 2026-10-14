// Pose-invariant shape comparison of triangle meshes – shared by the STEP import (instancing of identical
// solids that the file does not declare as reused) and the debug measurement (duplicate-scan.js).
//
// Fingerprint (analyzeShape, runs in the STEP workers): surface area, volume about the centroid, eigenvalues
// of the area covariance (exact triangle moments), local frame q = Eᵀ (p − C), area-weighted sample points and
// a subset of the vertices in that frame, angular harmonics about a free axis.
// Matching (matchShape): features within tolerance → candidate rotations between the two local frames
// (4 sign variants; with two equal eigenvalues the angle about the distinct axis from the harmonics,
// k-fold ambiguity of the first significant one) → points of each shape must lie on the other's surface
// (closest-point query, caller provides it – usually a BVH). Isotropic shapes (three equal eigenvalues:
// spheres, cubes) cannot be aligned this way and never match.

import { Vector3 } from 'three';

const FEATURE_TOL = 0.01;   // relative tolerance of area / eigenvalues
const DEGENERATE = 0.01;    // eigenvalues closer than this (relative to the largest) = rotation free
const SAMPLES = 128;        // area-weighted surface samples
const VERTICES = 512;       // vertex subset (catches small features such as holes, which samples may miss)
const HARMONICS = 8;

/** bucket for candidate search (neighbouring buckets ±1 must be checked as well) */
export const shapeBucket = fp => Math.round(Math.log(fp.area) / FEATURE_TOL);

/**
 * @param {{ positions: ArrayLike<number>, index?: ArrayLike<number> | null }[]} parts  in a common frame
 * @param {number} seed  sample seed (deterministic)
 */
export function analyzeShape(parts, seed = 1) {
    // pass 1: area, centroid, second moments about the origin
    let A = 0, cx = 0, cy = 0, cz = 0, triangles = 0, vertexCount = 0;
    let mxx = 0, myy = 0, mzz = 0, mxy = 0, mxz = 0, myz = 0;
    for (const { positions: p, index } of parts) {
        vertexCount += p.length / 3;
        const n = index ? index.length : p.length / 3;
        for (let t = 0; t < n; t += 3) {
            const i0 = (index ? index[t] : t) * 3, i1 = (index ? index[t + 1] : t + 1) * 3, i2 = (index ? index[t + 2] : t + 2) * 3;
            const ax = p[i0], ay = p[i0 + 1], az = p[i0 + 2], bx = p[i1], by = p[i1 + 1], bz = p[i1 + 2], qx = p[i2], qy = p[i2 + 1], qz = p[i2 + 2];
            triangles++;
            const ux = bx - ax, uy = by - ay, uz = bz - az, vx = qx - ax, vy = qy - ay, vz = qz - az;
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const a = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
            if (!a) continue;
            const sx = ax + bx + qx, sy = ay + by + qy, sz = az + bz + qz;
            A += a; cx += a * sx / 3; cy += a * sy / 3; cz += a * sz / 3;
            // ∫ x xᵀ dA over a triangle = a/12 · (Σ pᵢ pᵢᵀ + s sᵀ)
            const w = a / 12;
            mxx += w * (ax * ax + bx * bx + qx * qx + sx * sx);
            myy += w * (ay * ay + by * by + qy * qy + sy * sy);
            mzz += w * (az * az + bz * bz + qz * qz + sz * sz);
            mxy += w * (ax * ay + bx * by + qx * qy + sx * sy);
            mxz += w * (ax * az + bx * bz + qx * qz + sx * sz);
            myz += w * (ay * az + by * bz + qy * qz + sy * sz);
        }
    }
    const fp = { triangles, area: A };
    if (!A) return fp;
    const C = [cx / A, cy / A, cz / A];
    const cov = [
        [mxx / A - C[0] * C[0], mxy / A - C[0] * C[1], mxz / A - C[0] * C[2]],
        [mxy / A - C[0] * C[1], myy / A - C[1] * C[1], myz / A - C[1] * C[2]],
        [mxz / A - C[0] * C[2], myz / A - C[1] * C[2], mzz / A - C[2] * C[2]],
    ];
    const { values, vectors: E } = eigen(cov);   // descending, columns, right-handed
    const lambda = values.map(v => Math.max(v, 0));
    const scale = Math.sqrt(lambda[0] + lambda[1] + lambda[2]) || 1;   // RMS radius
    let axis = -1;   // free rotation axis: the eigenvalue that differs from the other two (3 = isotropic)
    const close = (i, j) => Math.abs(lambda[i] - lambda[j]) < DEGENERATE * lambda[0];
    if (close(0, 1) && close(1, 2)) axis = 3;
    else if (close(0, 1)) axis = 2;
    else if (close(1, 2)) axis = 0;
    const [iu, iv] = axis >= 0 && axis < 3 ? [0, 1, 2].filter(k => k !== axis) : [0, 1];

    // pass 2 in the local frame: volume, harmonics, samples, vertex subset
    const e00 = E[0][0], e01 = E[0][1], e02 = E[0][2], e10 = E[1][0], e11 = E[1][1], e12 = E[1][2], e20 = E[2][0], e21 = E[2][1], e22 = E[2][2];
    const L = new Float64Array(9);
    const local = (p, i, o) => {
        const dx = p[i] - C[0], dy = p[i + 1] - C[1], dz = p[i + 2] - C[2];
        L[o] = e00 * dx + e10 * dy + e20 * dz;
        L[o + 1] = e01 * dx + e11 * dy + e21 * dz;
        L[o + 2] = e02 * dx + e12 * dy + e22 * dz;
    };
    const rnd = random(seed);
    const targets = Array.from({ length: SAMPLES }, () => rnd() * A).sort((a, b) => a - b);
    const samples = new Float64Array(SAMPLES * 3);
    const harm = new Float64Array(HARMONICS * 2);
    let harmWeight = 0, V = 0, acc = 0, next = 0;
    const planar = axis >= 0 && axis < 3;
    for (const { positions: p, index } of parts) {
        const n = index ? index.length : p.length / 3;
        for (let t = 0; t < n; t += 3) {
            local(p, (index ? index[t] : t) * 3, 0);
            local(p, (index ? index[t + 1] : t + 1) * 3, 3);
            local(p, (index ? index[t + 2] : t + 2) * 3, 6);
            const ux = L[3] - L[0], uy = L[4] - L[1], uz = L[5] - L[2], vx = L[6] - L[0], vy = L[7] - L[1], vz = L[8] - L[2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const a = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
            if (!a) continue;
            V += (L[0] * (L[4] * L[8] - L[5] * L[7]) + L[1] * (L[5] * L[6] - L[3] * L[8]) + L[2] * (L[3] * L[7] - L[4] * L[6])) / 6;
            if (planar) {
                const cu = (L[iu] + L[3 + iu] + L[6 + iu]) / 3, cv = (L[iv] + L[3 + iv] + L[6 + iv]) / 3;
                const r = Math.hypot(cu, cv);
                if (r > 0) {
                    const phi = Math.atan2(cv, cu), w = a * r;
                    harmWeight += w;
                    for (let k = 1; k <= HARMONICS; k++) { harm[k * 2 - 2] += w * Math.cos(k * phi); harm[k * 2 - 1] += w * Math.sin(k * phi); }
                }
            }
            acc += a;
            while (next < SAMPLES && targets[next] <= acc) {
                let s = rnd(), r = rnd();
                if (s + r > 1) { s = 1 - s; r = 1 - r; }
                samples[next * 3] = L[0] + ux * s + vx * r;
                samples[next * 3 + 1] = L[1] + uy * s + vy * r;
                samples[next * 3 + 2] = L[2] + uz * s + vz * r;
                next++;
            }
        }
    }
    // rounding at the very end of the area sum: remaining samples on the last triangle's first corner
    for (; next < SAMPLES; next++) samples.set(L.subarray(0, 3), next * 3);
    const step = Math.max(1, Math.ceil(vertexCount / VERTICES));
    const vertices = new Float64Array(Math.ceil(vertexCount / step) * 3);
    let vi = 0, global = 0;
    for (const { positions: p } of parts) {
        for (let i = 0; i < p.length; i += 3, global++) {
            if (global % step) continue;
            local(p, i, 0);
            vertices.set(L.subarray(0, 3), vi);
            vi += 3;
        }
    }
    return Object.assign(fp, { C, E, lambda, scale, axis, iu, iv, volume: V, harm, harmWeight, samples, vertices: vertices.subarray(0, vi) });
}

export function featuresMatch(a, b) {
    if (!a.area || !b.area) return false;
    if (Math.abs(a.area - b.area) > FEATURE_TOL * Math.max(a.area, b.area)) return false;
    if (Math.abs(a.scale - b.scale) > FEATURE_TOL * a.scale) return false;
    for (let k = 0; k < 3; k++) if (Math.abs(Math.sqrt(a.lambda[k]) - Math.sqrt(b.lambda[k])) > FEATURE_TOL * a.scale) return false;
    // |volume|: mirrored solids have the opposite sign; open shells have a (pose-invariant) value as well
    return Math.abs(Math.abs(a.volume) - Math.abs(b.volume)) <= 0.03 * Math.max(Math.abs(a.volume), Math.abs(b.volume)) + 1e-3 * a.scale ** 3;
}

/**
 * Rotation R (local frame of b → local frame of a) under which b lies on a and a on b, or null.
 * @param {object} a  fingerprint
 * @param {object} b  fingerprint
 * @param {{ closestA: (x, y, z, tol) => boolean, closestB: (x, y, z, tol) => boolean, tol: number,
 *   missRatio?: number, mirrored?: boolean, vertices?: boolean }} options
 *   closestX: is there surface of X within tol of the point (world frame of X)?
 *   mirrored: also accept mirrored matches (result.mirrored = true)
 * @returns {{ R: number[][], mirrored: boolean } | null}
 */
export function matchShape(a, b, { closestA, closestB, tol, missRatio = 0, mirrored = false, vertices = true }) {
    if (a.axis === 3 || b.axis === 3 || a.axis !== b.axis) return null;
    for (const c of candidateRotations(a, b, mirrored)) {
        if (!fits(b, a, c.R, closestA, tol, missRatio, vertices)) continue;
        if (!fits(a, b, transpose(c.R), closestB, tol, missRatio, vertices)) continue;
        return c;
    }
    return null;
}

/**
 * 4×4 matrix (column-major, three.js `fromArray`) that maps points of shape a (its own frame) onto the place of
 * shape b: p_b = C_b + E_b · Rᵀ · E_aᵀ · (p_a − C_a), R from matchShape(a, b).
 */
export function alignmentMatrix(a, b, R) {
    const M = mul(mul(b.E, transpose(R)), transpose(a.E));
    const t = [0, 1, 2].map(i => b.C[i] - (M[i][0] * a.C[0] + M[i][1] * a.C[1] + M[i][2] * a.C[2]));
    return [M[0][0], M[1][0], M[2][0], 0, M[0][1], M[1][1], M[2][1], 0, M[0][2], M[1][2], M[2][2], 0, t[0], t[1], t[2], 1];
}

/** closest-point test against a MeshBVH, for matchShape */
export function bvhTester(bvhs) {
    const p = new Vector3(), hit = {};
    return (x, y, z, tol) => {
        p.set(x, y, z);
        // maxThreshold only prunes boxes – a triangle beyond it can still be returned, so check the distance
        for (const bvh of bvhs) if (bvh.closestPointToPoint(p, hit, tol, tol)?.distance <= tol) return true;
        return false;
    };
}

function candidateRotations(a, b, withMirrored) {
    const out = [];
    const diag = (x, y, z) => [[x, 0, 0], [0, y, 0], [0, 0, z]];
    if (a.axis < 0) {
        for (const [x, y, z] of [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]) out.push({ R: diag(x, y, z), mirrored: false });
        if (withMirrored) for (const [x, y, z] of [[-1, 1, 1], [1, -1, 1], [1, 1, -1], [-1, -1, -1]]) out.push({ R: diag(x, y, z), mirrored: true });
        return out;
    }
    // in-plane: identity or u flip; flipping the axis as well makes it proper / improper
    const { axis, iu, iv } = a;
    for (const flipU of [false, true]) {
        for (const flipAxis of [false, true]) {
            const mirrored = flipU !== flipAxis;
            if (mirrored && !withMirrored) continue;
            for (const theta of planeAngles(a, b, flipU)) {
                const F = diag(1, 1, 1);
                if (flipU) F[iu][iu] = -1;
                if (flipAxis) F[axis][axis] = -1;
                const Rot = diag(1, 1, 1);
                const c = Math.cos(theta), s = Math.sin(theta);
                Rot[iu][iu] = c; Rot[iu][iv] = -s; Rot[iv][iu] = s; Rot[iv][iv] = c;
                out.push({ R: mul(Rot, F), mirrored });
            }
        }
    }
    return out;
}

// angles θ about the free axis that map b's harmonics onto a's (k-fold ambiguity of the first significant one)
function planeAngles(a, b, flipU) {
    for (let k = 1; k <= HARMONICS; k++) {
        const ar = a.harm[k * 2 - 2], ai = a.harm[k * 2 - 1];
        if (Math.hypot(ar, ai) < 0.02 * a.harmWeight) continue;
        let br = b.harm[k * 2 - 2], bi = b.harm[k * 2 - 1];
        if (flipU) { const sign = k % 2 ? -1 : 1; br *= sign; bi *= -sign; }   // φ → π − φ
        const base = (Math.atan2(ai, ar) - Math.atan2(bi, br)) / k;
        return Array.from({ length: k }, (_, j) => base + 2 * Math.PI * j / k);
    }
    return [0];   // rotationally symmetric: any angle
}

// points of `from` (local) → rotated into `to`'s local frame → world of `to` → surface of `to` within tol?
function fits(from, to, R, closest, tol, missRatio, withVertices) {
    const sets = withVertices ? [from.samples, from.vertices] : [from.samples];
    const total = sets.reduce((s, x) => s + x.length / 3, 0);
    const allowed = Math.floor(total * missRatio);
    const E = to.E, C = to.C;
    let miss = 0;
    for (const pts of sets) {
        for (let i = 0; i < pts.length; i += 3) {
            const q0 = pts[i], q1 = pts[i + 1], q2 = pts[i + 2];
            const l0 = R[0][0] * q0 + R[0][1] * q1 + R[0][2] * q2;
            const l1 = R[1][0] * q0 + R[1][1] * q1 + R[1][2] * q2;
            const l2 = R[2][0] * q0 + R[2][1] * q1 + R[2][2] * q2;
            const x = C[0] + E[0][0] * l0 + E[0][1] * l1 + E[0][2] * l2;
            const y = C[1] + E[1][0] * l0 + E[1][1] * l1 + E[1][2] * l2;
            const z = C[2] + E[2][0] * l0 + E[2][1] * l1 + E[2][2] * l2;
            if (!closest(x, y, z, tol) && ++miss > allowed) return false;
        }
    }
    return true;
}

const mul = (A, B) => A.map(row => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const transpose = A => [0, 1, 2].map(i => [A[0][i], A[1][i], A[2][i]]);

// Jacobi eigen decomposition of a symmetric 3×3 matrix: values descending, vectors as columns, det +1
function eigen(S) {
    const a = S.map(r => [...r]);
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
        if (off < 1e-14 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (!a[p][q]) continue;
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[k][p], vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
    const vectors = [0, 1, 2].map(r => order.map(c => v[r][c]));
    const det = vectors[0][0] * (vectors[1][1] * vectors[2][2] - vectors[1][2] * vectors[2][1])
        - vectors[0][1] * (vectors[1][0] * vectors[2][2] - vectors[1][2] * vectors[2][0])
        + vectors[0][2] * (vectors[1][0] * vectors[2][1] - vectors[1][1] * vectors[2][0]);
    if (det < 0) for (let r = 0; r < 3; r++) vectors[r][2] = -vectors[r][2];
    return { values: order.map(i => a[i][i]), vectors };
}

function random(seed) {
    let s = (seed * 2654435761) >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}
