// Parallel PLY parser (splat-loader.js): every worker reads its own range of vertex rows – dropped file via
// file.slice, URL via an HTTP range request – and writes the splats straight into the shared buffers.
// Reports the rows done (progressive display) and finally the stats of its range (bounds, pick sample).
import { SplatBuilder, RowReader, plyRowDecoder } from './splat-formats.js';

self.onmessage = async ({ data }) => {
    const { file, url, layout, start, rows, total, buffers, shCoeffs, shRange } = data;
    try {
        const builder = new SplatBuilder(total, shCoeffs, true, buffers);
        builder.shRange = shRange;
        const decode = plyRowDecoder(layout, builder);
        const from = layout.offset + start * layout.rowSize, to = from + rows * layout.rowSize;
        let body;
        if (file) body = file.slice(from, to).stream();
        else {
            const res = await fetch(url, { headers: { Range: `bytes=${from}-${to - 1}` } });
            if (res.status !== 206) throw new Error(`HTTP ${res.status}${res.ok ? ': no range request support' : ''}`);
            body = res.body;
        }
        let last = 0;
        await new RowReader(body.getReader(), null).rows(layout.rowSize, rows, (buf, n, first) => {
            decode(buf, n, start + first);
            const now = performance.now();
            if (now - last > 100 || first + n === rows) { last = now; self.postMessage({ type: 'progress', done: first + n }); }
        });
        const stats = builder.rangeStats(start, start + rows);
        self.postMessage({ type: 'done', stats }, [stats.pickIndex.buffer, stats.pickRadius.buffer]);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
