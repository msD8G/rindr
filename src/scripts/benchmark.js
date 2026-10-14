// Path tracing benchmark (only with ?bench in the URL): measures samples/s for different
// path tracer variants on the real GPU. The camera stands still, denoising is off meanwhile.
//   Method: wavefront (library default) or megakernel
//   frameBudget: paths per pass (default 250 000)
//   Resolution: renderScale
// Result: table in a window (copyable) + console.table.
// Result rows/header use stable English keys; column titles are translated when shown (benchmark.columns.*).
import { Vector2 } from 'three/webgpu';
import { t } from './i18n.js';

const CONFIGS = [
    { kernel: 'wavefront', budget: 250_000, scale: 0.5, labelKey: 'benchmark.defaultVariant' },
    { kernel: 'wavefront', budget: 1_000_000, scale: 0.5 },
    { kernel: 'wavefront', budget: 4_000_000, scale: 0.5 },
    { kernel: 'megakernel', budget: 250_000, scale: 0.5 },
    { kernel: 'megakernel', budget: 1_000_000, scale: 0.5 },
    { kernel: 'megakernel', budget: 4_000_000, scale: 0.5 },
    { kernel: 'wavefront', budget: 250_000, scale: 1 },
    { kernel: 'megakernel', budget: 1_000_000, scale: 1 },
];
const WARMUP_MS = 1500;    // after the first sample (shader compilation is over by then)
const MEASURE_MS = 6000;
const FIRST_SAMPLE_TIMEOUT = 60000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {import('./pathtracer.js').PathTracingView} view
 * @param {{ renderer, onProgress?: (text: string) => void }} ctx
 */
export async function runBenchmark(view, { renderer, onProgress = () => {} }) {
    await view.load();
    const pt = view.pathTracer;
    const saved = {
        maxSamples: pt.maxSamples, renderScale: pt.renderScale, frameBudget: pt.frameBudget,
        denoise: view.denoiseEnabled, megakernel: !!view._megakernel,   // class name is minified in the build
    };
    view.setDenoise(false);
    pt.maxSamples = 0;   // unlimited

    // count the frame rate too (shows whether the UI stays smooth)
    let frames = 0, counting = true;
    const tick = () => { frames++; if (counting) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);

    const results = [];
    let currentMega = saved.megakernel;
    try {
        for (const [i, c] of CONFIGS.entries()) {
            const name = `${c.kernel} · ${(c.budget / 1e6).toFixed(2)} M · ${c.scale}`;
            onProgress(t('benchmark.progress', { index: i + 1, total: CONFIGS.length, name }));
            const mega = c.kernel === 'megakernel';
            if (mega !== currentMega) {
                pt.useMegakernel(mega);
                pt.maxBounces = view.bounces;   // not carried over on switching
                currentMega = mega;
            }
            pt.frameBudget = c.budget;
            pt.renderScale = c.scale;
            pt.maxSamples = 0;
            pt.reset();

            // wait for the first sample (shader compilation), then settle
            const t0 = performance.now();
            let counts = await pt.getSampleCountsAsync();
            while (counts.avg <= 0 && performance.now() - t0 < FIRST_SAMPLE_TIMEOUT) {
                await sleep(100);
                counts = await pt.getSampleCountsAsync();
            }
            const firstSampleMs = performance.now() - t0;
            if (counts.avg <= 0) {
                results.push({ variant: name, note: c.labelKey ? t(c.labelKey) : '', samplesPerSecond: 0, megaPathsPerSecond: 0, fps: 0, firstSampleMs: Math.round(firstSampleMs), error: t('benchmark.noSample') });
                continue;
            }
            await sleep(WARMUP_MS);

            const a = await pt.getSampleCountsAsync();
            const ta = performance.now(), fa = frames;
            await sleep(MEASURE_MS);
            const b = await pt.getSampleCountsAsync();
            const tb = performance.now(), fb = frames;

            const seconds = (tb - ta) / 1000;
            const sps = (b.avg - a.avg) / seconds;
            const size = new Vector2();
            pt._pathTracer.getSize(size);
            const pixels = size.x * size.y;
            results.push({
                variant: name,
                note: c.labelKey ? t(c.labelKey) : '',
                samplesPerSecond: +sps.toFixed(2),
                megaPathsPerSecond: +(sps * pixels / 1e6).toFixed(1),
                fps: Math.round((fb - fa) / seconds),
                firstSampleMs: Math.round(firstSampleMs),
                pixels: `${size.x}×${size.y}`,
            });
            console.info('[Benchmark]', results.at(-1));
        }
    } finally {
        counting = false;
        // restore the initial state
        if (currentMega !== saved.megakernel) { pt.useMegakernel(saved.megakernel); pt.maxBounces = view.bounces; }
        pt.frameBudget = saved.frameBudget;
        pt.renderScale = saved.renderScale;
        pt.maxSamples = saved.maxSamples;
        view.setDenoise(saved.denoise);
        pt.reset();
    }

    const info = renderer.backend?.adapter?.info || {};
    const header = {
        gpu: [info.vendor, info.architecture, info.description, info.device].filter(Boolean).join(' / ') || t('benchmark.unknown'),
        window: `${innerWidth}×${innerHeight} @ ${devicePixelRatio}x`,
        bounces: view.bounces,
        browser: navigator.userAgent.match(/(Chrome|Edg|Firefox)\/[\d.]+/g)?.join(' ') || navigator.userAgent,
    };
    console.info('[Benchmark]', header);
    console.table(results);
    return { header, results };
}

/** Show the result as a window with a table + copy button */
export function showBenchmarkResult({ header, results }) {
    const cols = Object.keys(results[0] || {});
    const colName = c => t(`benchmark.columns.${c}`);
    const headName = k => t(`benchmark.header.${k}`);
    const text = [
        ...Object.entries(header).map(([k, v]) => `${headName(k)}: ${v}`),
        '',
        cols.map(colName).join('\t'),
        ...results.map(r => cols.map(c => r[c] ?? '').join('\t')),
    ].join('\n');
    const box = document.createElement('div');
    box.className = 'absolute left-1/2 top-1/2 z-30 max-h-[80dvh] w-[min(56rem,95vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg bg-neutral-900/95 p-4 text-xs text-white/90 shadow-2xl ring-1 ring-white/15';
    const best = Math.max(...results.map(r => r.samplesPerSecond || 0));
    box.innerHTML = `
        <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-sm font-medium">${escapeHtml(t('benchmark.title'))}</span>
            <span class="flex gap-1">
                <button data-copy class="rounded bg-sky-500/40 px-2 py-0.5 hover:bg-sky-500/60">${escapeHtml(t('benchmark.copy'))}</button>
                <button data-close class="rounded px-2 py-0.5 hover:bg-white/15">${escapeHtml(t('benchmark.close'))}</button>
            </span>
        </div>
        <div class="mb-2 text-white/60">${Object.entries(header).map(([k, v]) => `<div><b class="text-white/80">${escapeHtml(headName(k))}:</b> ${escapeHtml(String(v))}</div>`).join('')}</div>
        <table class="w-full tabular-nums">
            <thead><tr>${cols.map(c => `<th class="border-b border-white/15 px-1.5 py-1 text-left font-medium text-white/60">${escapeHtml(colName(c))}</th>`).join('')}</tr></thead>
            <tbody>${results.map(r => `<tr class="${r.samplesPerSecond === best ? 'bg-emerald-500/20' : ''}">${cols.map(c => `<td class="px-1.5 py-0.5">${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>`;
    box.querySelector('[data-copy]').onclick = async e => {
        try { await navigator.clipboard.writeText(text); e.target.textContent = t('benchmark.copied'); }
        catch { e.target.textContent = t('benchmark.copyFailed'); }
    };
    box.querySelector('[data-close]').onclick = () => box.remove();
    document.body.append(box);
    return text;
}

function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
