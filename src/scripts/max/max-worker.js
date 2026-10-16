// Worker of the .max reader (max-parse.js): gets the file buffer (transferred), answers with the scene description
// and the geometry buffers (transferred, no copies).
import { describeMax, buildMaxGeometry } from './max-parse.js';

// gzip → bytes with the platform's DecompressionStream (files saved with "Compress on save")
async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

self.onmessage = async ({ data }) => {
    try {
        const described = await describeMax(data.buffer, gunzip);
        const geometries = [];
        const transfer = [];
        const total = described.geometries.length;
        for (let g = 0; g < total; g++) {
            const parts = buildMaxGeometry(described, g);
            for (const p of parts) for (const a of [p.positions, p.normals, p.uvs, p.index]) if (a) transfer.push(a.buffer);
            geometries.push(parts);
            self.postMessage({ type: 'progress', done: g + 1, total });
        }
        const { unitMm, nodes, materials, textures, unsupported } = described;
        self.postMessage({ type: 'done', scene: { unitMm, nodes, materials, textures, unsupported }, geometries }, transfer);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
