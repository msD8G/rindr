// Gradient editor of the HDRI editor (gradient pins, background gradient): a bar showing the gradient, stop
// markers below it. Click into the bar = new stop (colour taken from the gradient there), drag a marker = move it,
// double-click a marker = colour picker (ui-controls.js), drag it far up/down = remove it (at least two stops stay).
import { t } from '../i18n.js';
import { fmt, openColorPicker } from '../ui-controls.js';

const REMOVE_DISTANCE = 36;   // px away from the markers → the stop is removed on release
const DOUBLE_CLICK_MS = 400;

/**
 * @param {{ stops: {pos: number, color: string}[], min: number, max: number, step: number,
 *           startLabel?: string, endLabel?: string, onChange: (kind: 'live' | 'commit') => void }} opts
 *   stops are edited in place; onChange('live') while dragging/picking, ('commit') when a change is finished
 * @returns {HTMLElement}
 */
export function gradientEditor({ stops, min, max, step, startLabel, endLabel, onChange }) {
    const root = el('div', 'px-2 select-none');   // inset: markers at the ends stay fully visible
    const bar = el('div', 'relative h-5 cursor-copy rounded ring-1 ring-white/20');
    bar.title = t('hdriEditor.gradientAddHint');
    const track = el('div', 'relative h-5');
    track.title = t('hdriEditor.stopHint');
    const labels = el('div', 'flex justify-between text-[10px] text-white/40');
    if (startLabel || endLabel) labels.append(el('span', '', startLabel || ''), el('span', '', endLabel || ''));
    root.append(bar, track, labels);

    let selected = stops[0] ?? null;
    let lastDown = { stop: null, time: 0 };
    const span = max - min;
    const toPct = v => (v - min) / span * 100;
    const snap = v => Math.min(max, Math.max(min, step > 0 ? Math.round(v / step) * step : v));
    const css = list => (list.length === 1 ? list[0].color
        : `linear-gradient(to right, ${[...list].sort((a, b) => a.pos - b.pos).map(s => `${s.color} ${toPct(s.pos).toFixed(2)}%`).join(', ')})`);

    const paint = () => {
        bar.style.background = css(stops);
        track.replaceChildren(...stops.map(stop => marker(stop)));
    };

    // marker: swatch below the bar; drag = move, far away = remove, double click = colour picker
    function marker(stop) {
        // round, the size of the slider handles: 12 px + 2 px ring on each side = 16 px
        const m = el('div', `absolute top-1 size-3 -translate-x-1/2 cursor-ew-resize rounded-full shadow ${stop === selected ? 'ring-2 ring-sky-400' : 'ring-2 ring-white/70'}`);
        m.style.left = `${toPct(stop.pos)}%`;
        m.style.background = stop.color;
        m.title = `${fmt(stop.pos)} – ${t('hdriEditor.stopHint')}`;
        m.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            // own double-click detection: the markers are rebuilt on selection, a native dblclick would not arrive
            const now = performance.now();
            const double = lastDown.stop === stop && now - lastDown.time < DOUBLE_CLICK_MS;
            lastDown = { stop, time: now };
            if (selected !== stop) { selected = stop; paint(); }
            const handle = track.children[stops.indexOf(stop)];
            if (double) { pickColor(stop, handle); return; }
            const rect = bar.getBoundingClientRect(), y0 = e.clientY, x0 = e.clientX;
            let moved = false, remove = false;
            handle.setPointerCapture(e.pointerId);
            const move = ev => {
                if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
                moved = true;
                stop.pos = snap(min + (ev.clientX - rect.left) / rect.width * span);
                remove = stops.length > 2 && Math.abs(ev.clientY - y0) > REMOVE_DISTANCE;
                handle.style.left = `${toPct(stop.pos)}%`;
                handle.style.opacity = remove ? '0.3' : '';
                bar.style.background = css(stops.filter(s => !(remove && s === stop)));
                onChange('live');
            };
            const up = () => {
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', up);
                handle.removeEventListener('pointercancel', up);
                if (remove) { stops.splice(stops.indexOf(stop), 1); selected = stops[0]; }
                if (moved) { lastDown = { stop: null, time: 0 }; paint(); onChange('commit'); }
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
            handle.addEventListener('pointercancel', up);
        });
        return m;
    }

    function pickColor(stop, anchor) {
        const apply = hex => {
            stop.color = hex;
            bar.style.background = css(stops);
            const m = track.children[stops.indexOf(stop)];
            if (m) m.style.background = hex;
        };
        openColorPicker(anchor, stop.color, {
            onInput: hex => { apply(hex); onChange('live'); },
            onChange: hex => { apply(hex); onChange('commit'); },
        });
    }

    // click into the bar: new stop with the colour of the gradient there
    bar.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const rect = bar.getBoundingClientRect();
        const p = snap(min + (e.clientX - rect.left) / rect.width * span);
        const stop = { pos: p, color: colorAt(stops, p) };
        stops.push(stop);
        selected = stop;
        paint();
        onChange('commit');
    });

    paint();
    return root;
}

// colour of the gradient at a position (interpolated in sRGB like the CSS preview)
function colorAt(stops, p) {
    const sorted = [...stops].sort((a, b) => a.pos - b.pos);
    if (!sorted.length) return '#808080';
    if (p <= sorted[0].pos) return sorted[0].color;
    for (let i = 1; i < sorted.length; i++) {
        if (p <= sorted[i].pos) {
            const a = sorted[i - 1], b = sorted[i], k = (p - a.pos) / Math.max(b.pos - a.pos, 1e-9);
            const ca = hex(a.color), cb = hex(b.color);
            return '#' + ca.map((v, c) => Math.round(v + (cb[c] - v) * k).toString(16).padStart(2, '0')).join('');
        }
    }
    return sorted[sorted.length - 1].color;
}
const hex = h => { const n = parseInt(String(h).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}
