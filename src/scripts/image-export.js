// Image export (button in the bottom bar): the current view as PNG – optionally with a transparent
// background that keeps the ground shadow – or as JPG, in the canvas resolution or 2–4× larger (rendered again
// at that size, up to ctx.maxSize() px per side). In HQ the export waits for
// the finished (denoised) image like the AI button. Panel style like the other windows, no darkening.
// The image itself comes from the viewer (ctx.exportImage → canvas; transparency: exportImage/composeMatte in viewer.js).
import { t } from './i18n.js';
import { dialogOpen } from './dialog.js';

const BTN = 'rounded px-3 py-1 outline-none transition-colors';
const ICON_CLOSE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/**
 * @param {{ exportImage(transparent: boolean, onProgress: (text: string, p: number) => void, isOpen: () => boolean): Promise<HTMLCanvasElement|Blob>,
 *           getName(): string, getSize(): { width: number, height: number }, maxSize(): number }} ctx
 *   exportImage(transparent, onProgress, isOpen, scale)
 */
export function createImageExport(ctx) {
    const state = { format: 'png', transparent: true, scale: 1, busy: false };
    const SCALES = [1, 2, 3, 4];
    const root = document.createElement('div');
    root.className = 'pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-4 text-xs text-white/90';
    root.hidden = true;
    document.body.append(root);

    const close = () => { root.hidden = true; state.busy = false; };
    document.addEventListener('pointerdown', e => {
        if (root.hidden || dialogOpen()) return;
        if (!root.firstElementChild?.contains(e.target)) close();
    }, true);
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden && !dialogOpen()) { e.stopPropagation(); close(); } }, true);

    function render(progress = null) {
        const panel = document.createElement('div');
        panel.className = 'pointer-events-auto w-[min(22rem,100%)] overflow-hidden rounded-lg bg-black/60 shadow-2xl backdrop-blur-sm';
        const head = document.createElement('div');
        head.className = 'flex items-center gap-2 border-b border-white/10 px-4 py-2.5';
        const title = document.createElement('span');
        title.className = 'flex-1 font-medium';
        title.textContent = t('imageExport.title');
        const x = document.createElement('button');
        x.className = 'text-white/50 hover:text-white';
        x.innerHTML = ICON_CLOSE;
        x.title = t('setup.close');
        x.onclick = close;
        head.append(title, x);

        const body = document.createElement('div');
        body.className = 'flex flex-col gap-2.5 px-4 py-3';
        // format
        const formats = document.createElement('div');
        formats.className = 'flex gap-1';
        for (const f of ['png', 'jpg']) {
            const b = document.createElement('button');
            b.className = `${BTN} ${state.format === f ? 'bg-sky-500/40 text-white' : 'bg-white/10 text-white/80 hover:bg-white/20'}`;
            b.textContent = f.toUpperCase();
            b.disabled = state.busy;
            b.onclick = () => { state.format = f; render(); };
            formats.append(b);
        }
        body.append(row(t('imageExport.format'), formats));
        // transparent background (PNG)
        if (state.format === 'png') {
            const label = document.createElement('label');
            label.className = 'flex cursor-pointer items-start gap-2';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.className = 'mt-0.5 accent-sky-400';
            box.checked = state.transparent;
            box.disabled = state.busy;
            box.onchange = () => { state.transparent = box.checked; render(); };
            const text = document.createElement('span');
            text.append(t('imageExport.transparent'));
            const hint = document.createElement('div');
            hint.className = 'text-white/40';
            hint.textContent = t('imageExport.transparentHint');
            text.append(hint);
            label.append(box, text);
            body.append(label);
        }
        // size: screen resolution or a multiple (only what the GPU can hold)
        const { width, height } = ctx.getSize();
        const max = ctx.maxSize();
        const fits = s => Math.max(width, height) * s <= max;
        if (!fits(state.scale)) state.scale = 1;
        const scales = document.createElement('div');
        scales.className = 'flex gap-1';
        scales.title = t('imageExport.scaleTitle');
        for (const s of SCALES) {
            const b = document.createElement('button');
            b.className = `${BTN} ${state.scale === s ? 'bg-sky-500/40 text-white' : 'bg-white/10 text-white/80 hover:bg-white/20'} disabled:opacity-30`;
            b.textContent = `${s}×`;
            b.disabled = state.busy || !fits(s);
            b.title = fits(s) ? t('imageExport.size', { width: width * s, height: height * s }) : t('imageExport.tooLarge', { max });
            b.onclick = () => { state.scale = s; render(); };
            scales.append(b);
        }
        body.append(row(t('imageExport.scale'), scales));
        const size = document.createElement('div');
        size.className = 'text-white/50';
        size.textContent = state.scale === 1 ? t('imageExport.size', { width, height }) + ' · ' + t('imageExport.sizeScreen')
            : t('imageExport.size', { width: width * state.scale, height: height * state.scale });
        body.append(size);
        if (progress) {
            const p = document.createElement('div');
            p.className = 'text-sky-200';
            p.textContent = progress;
            body.append(p);
        }

        const foot = document.createElement('div');
        foot.className = 'flex justify-end gap-2 px-4 pb-3';
        const cancel = document.createElement('button');
        cancel.className = `${BTN} bg-white/10 text-white/80 hover:bg-white/20`;
        cancel.textContent = t('dialog.cancel');
        cancel.onclick = close;
        const go = document.createElement('button');
        go.className = `${BTN} bg-sky-500/80 text-white hover:bg-sky-500 disabled:opacity-50`;
        go.textContent = t('imageExport.export');
        go.disabled = state.busy;
        go.onclick = run;
        foot.append(cancel, go);

        panel.append(head, body, foot);
        root.replaceChildren(panel);
    }

    function row(label, control) {
        const r = document.createElement('div');
        r.className = 'flex items-center gap-3';
        const l = document.createElement('span');
        l.className = 'w-20 text-white/60';
        l.textContent = label;
        r.append(l, control);
        return r;
    }

    async function run() {
        state.busy = true;
        render(t('imageExport.preparing'));
        const transparent = state.format === 'png' && state.transparent;
        let canvas;
        try {
            canvas = await ctx.exportImage(transparent, text => { if (!root.hidden) render(text); }, () => !root.hidden, state.scale);
        } catch (err) {
            state.busy = false;
            if (!root.hidden) render(t('imageExport.failed', { message: err.message }));
            return;
        }
        const type = state.format === 'png' ? 'image/png' : 'image/jpeg';
        // transparent: already a finished PNG (premultiplied, see composeMatte), otherwise a canvas
        const blob = canvas instanceof Blob ? canvas : await new Promise(resolve => canvas.toBlob(resolve, type, 0.92));
        const name = `${ctx.getName() || 'rindr'}.${state.format}`;
        state.busy = false;
        close();
        await saveBlob(blob, name);
    }

    return {
        open() { if (!root.hidden) return; root.hidden = false; render(); },
        get isOpen() { return !root.hidden; },
    };
}

// always straight into the downloads (a "save as" dialog only works right after the click – in HQ the export
// waits for the finished image, then the browser refused the dialog and downloaded anyway: inconsistent)
async function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
