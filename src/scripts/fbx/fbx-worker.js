// Worker of the lean FBX reader (fbx-parse.js): gets the file buffer (transferred), answers with the scene
// description and the geometry buffers (transferred, no copies). Animated files / files with deformers are handed
// back untouched when the caller may still use three.js' loader for them (small files, `fallback`).
import { readTree, describeScene, buildGeometry } from './fbx-parse.js';

// zlib → bytes with the platform's DecompressionStream (no library)
async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

self.onmessage = async ({ data }) => {
    const { buffer, fallback } = data;
    try {
        const tree = readTree(buffer);
        const scene = describeScene(tree);
        if (fallback && (scene.hasAnimation || scene.hasDeformers)) {
            self.postMessage({ type: 'fallback', buffer }, [buffer]);
            return;
        }
        // embedded textures: own buffers (the file buffer is not sent back)
        const textures = scene.textures.map(t => ({ ...t, content: t.content ? buffer.slice(t.content.off, t.content.off + t.content.len) : null }));
        const geometries = [];
        const transfer = [];
        const total = scene.geometryNodes.length;
        for (let g = 0; g < total; g++) {
            const model = scene.models.find(m => m.geometries.includes(g));
            const parts = await buildGeometry(buffer, scene.geometryNodes[g], inflate, model?.geometric);
            for (const p of parts) for (const a of [p.positions, p.normals, p.uvs, p.index]) if (a) transfer.push(a.buffer);
            geometries.push(parts);
            self.postMessage({ type: 'progress', done: g + 1, total });
        }
        for (const t of textures) if (t.content) transfer.push(t.content);
        const { geometryNodes, ...description } = scene;
        self.postMessage({ type: 'done', scene: { ...description, textures }, geometries }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
