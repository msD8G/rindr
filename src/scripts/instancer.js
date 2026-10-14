// Instancing of identical shapes in the STEP import (tessellateStep in step-importer.js).

import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { featuresMatch, matchShape, shapeBucket, alignmentMatrix, bvhTester } from './shape-match.js';

/**
 * Instancing of identical shapes (STEP files often store the same part many times as separate solids – e.g.
 * per colour or flattened exports; measured on a large assembly: 43 % of the stored triangles).
 * Every finished geometry (with BVH + fingerprint from the worker) is compared with the earlier ones of the
 * same tessellation level; a match (shape-match.js: both ways, all sample points and a vertex subset within
 * 2 × chord error) drops the geometry – the group then points to the earlier one and gets an alignment
 * matrix (g.align, applied after the instance matrix in meshEntry). Proper rotations only: mirrored parts would
 * need a negative determinant (winding, normals). BVH and tessellation time are not saved (the comparison needs
 * both BVHs); memory, GPU buffers and the path tracer scene (dedupes per BVH) are.
 */
export class Instancer {
    constructor(geometries) {
        this.geometries = geometries;
        this.buckets = new Map();   // level → shapeBucket → [{ index, fp, defl }]
        this.testers = new Map();   // geometry index → closest-point test (MeshBVH over the worker's BVH)
        this.stats = { instancedGeometries: 0, instancedTriangles: 0, instancingMs: 0 };
    }

    tester(index) {
        if (!this.testers.has(index)) {
            const g = this.geometries[index];
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(g.positions, 3));
            geometry.setIndex(new BufferAttribute(g.index, 1));
            const bvh = MeshBVH.deserialize({ version: 1, roots: g.bvh, index: g.index, indirectBuffer: null }, geometry, { setIndex: false });
            this.testers.set(index, bvhTester([bvh]));
        }
        return this.testers.get(index);
    }

    add(group, level, defl) {
        const t0 = performance.now();
        const index = group.geometry, g = this.geometries[index];
        const fp = g.shape;
        delete g.shape;
        if (!fp?.area || fp.axis === 3) return;   // empty or isotropic (cannot be aligned)
        if (!this.buckets.has(level)) this.buckets.set(level, new Map());
        const buckets = this.buckets.get(level), key = shapeBucket(fp);
        for (let k = key - 1; k <= key + 1; k++) {
            for (const rep of buckets.get(k) || []) {
                if (!featuresMatch(rep.fp, fp)) continue;
                // chord error of both tessellations + float precision of the coordinates
                const tol = 2 * Math.max(defl, rep.defl) + 1e-4 * fp.scale + 1e-6 * (Math.hypot(...fp.C) + Math.hypot(...rep.fp.C));
                const m = matchShape(rep.fp, fp, { closestA: this.tester(rep.index), closestB: this.tester(index), tol });
                if (!m) continue;
                group.align = alignmentMatrix(rep.fp, fp, m.R);
                group.geometry = rep.index;
                this.geometries[index] = null;
                this.testers.delete(index);
                this.stats.instancedGeometries++;
                this.stats.instancedTriangles += fp.triangles;
                this.stats.instancingMs += performance.now() - t0;
                return;
            }
        }
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ index, fp, defl });
        this.stats.instancingMs += performance.now() - t0;
    }

    dispose() {
        this.buckets.clear();
        this.testers.clear();
        this.stats.instancingMs = Math.round(this.stats.instancingMs);
    }
}
