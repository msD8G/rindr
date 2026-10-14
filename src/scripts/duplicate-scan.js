// Measurement (debug only): how many geometries are identical in shape although they are stored separately?
// Answers whether instancing (shape-match.js, STEP import) pays off / what it still misses.
//
// Unit = one geometry (meshes sharing it count as instances – declared reuse in the file or already
// instanced by the import). Comparison as in the import (shape-match.js), but tolerant: surface tolerance
// relative to the shape size, 3 % misses allowed, mirrored matches counted separately.

import { MeshBVH } from 'three-mesh-bvh';
import { analyzeShape, featuresMatch, matchShape, shapeBucket, bvhTester } from './shape-match.js';

const SURFACE_TOL = 0.02;   // max. distance point → surface, relative to the RMS radius

/**
 * @param {Array<{ name: string, geometry: THREE.BufferGeometry, instances: number }>} units
 * @param {{ onProgress?: (done: number, total: number) => void }} options
 */
export async function scanDuplicates(units, { onProgress } = {}) {
    const t0 = performance.now();
    let lastYield = t0;
    const pause = async i => {
        if (performance.now() - lastYield < 50) return;
        onProgress?.(i, units.length);
        await new Promise(r => setTimeout(r));
        lastYield = performance.now();
    };
    const bvhCache = new Map();
    const testerOf = info => {
        const g = info.unit.geometry;
        if (!bvhCache.has(g)) bvhCache.set(g, bvhTester([g.boundsTree || new MeshBVH(g, { indirect: true })]));   // indirect: index untouched
        return bvhCache.get(g);
    };

    // 1. fingerprints
    const infos = [];
    for (let i = 0; i < units.length; i++) {
        const g = units[i].geometry;
        const fp = analyzeShape([{ positions: g.getAttribute('position').array, index: g.index?.array }], i + 1);
        infos.push({ index: i, unit: units[i], triangles: fp.triangles, fp });
        await pause(i);
    }

    // 2. group: representatives bucketed by log(area)
    const buckets = new Map();
    const groups = [];   // { rep, members: [{ info, mirrored }] }
    const order = infos.filter(f => f.fp.area > 0).sort((a, b) => b.triangles - a.triangles);
    let isotropic = 0;
    for (let n = 0; n < order.length; n++) {
        const f = order[n];
        if (f.fp.axis === 3) isotropic++;
        const key = shapeBucket(f.fp);
        let found = null;
        for (let k = key - 1; k <= key + 1 && !found; k++) {
            for (const g of buckets.get(k) || []) {
                if (!featuresMatch(g.rep.fp, f.fp)) continue;
                const m = matchShape(g.rep.fp, f.fp, {
                    closestA: testerOf(g.rep), closestB: testerOf(f),
                    tol: SURFACE_TOL * g.rep.fp.scale, missRatio: 0.03, mirrored: true,
                });
                if (m) { found = { group: g, mirrored: m.mirrored }; break; }
            }
        }
        if (found) found.group.members.push({ info: f, mirrored: found.mirrored });
        else {
            const g = { rep: f, members: [] };
            groups.push(g);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(g);
        }
        await pause(n);
    }
    bvhCache.clear();

    // 3. statistics: triangles that would no longer be stored
    const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
    const dup = groups.flatMap(g => g.members);
    const proper = dup.filter(m => !m.mirrored);
    const mirrored = dup.filter(m => m.mirrored);
    const top = groups.filter(g => g.members.length).map(g => ({
        name: g.rep.unit.name,
        geometries: g.members.length + 1,
        instances: g.rep.unit.instances + sum(g.members, m => m.info.unit.instances),
        trianglesEach: g.rep.triangles,
        saved: sum(g.members, m => m.info.triangles),
        mirrored: g.members.filter(m => m.mirrored).length,
    })).sort((a, b) => b.saved - a.saved);
    return {
        ms: performance.now() - t0,
        units: units.length,
        instances: sum(units, u => u.instances),
        triangles: sum(infos, f => f.triangles),
        groups: top.length,
        duplicates: proper.length, savedTriangles: sum(proper, m => m.info.triangles),
        mirrored: mirrored.length, savedMirrored: sum(mirrored, m => m.info.triangles),
        isotropic,
        top,
    };
}
