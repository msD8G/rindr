// Shared look and behaviour of the panel inputs (properties, materials, node editor, HDRI editor): classes of
// number/text fields, sliders, selects, checkboxes; number fields that can be dragged sideways like a slider; the
// number format; colour field with an own picker in the panel style (colorField).
// One implementation – every input looks and behaves the same.

/** number/text field (right-aligned numbers) */
export const INPUT = 'w-full min-w-0 rounded bg-white/10 px-1.5 py-0.5 text-right tabular-nums text-white outline-none focus:bg-white/20';
/** select (like INPUT, left-aligned) */
export const SELECT = INPUT.replace('text-right', 'text-left') + ' cursor-pointer';
/** slider */
export const RANGE = 'min-w-0 flex-1 accent-sky-400';
/** checkbox */
export const CHECKBOX = 'size-3.5 shrink-0 cursor-pointer accent-sky-400';

// Drag a number field sideways to change it (like a slider); a click without moving
// edits it as usual, while it has the focus it is a normal text field. Shift = 10× faster, Alt = 10× finer.
export function draggable(input, { perPixel, min = -Infinity, max = Infinity, step = 0, onDrag, onStart, onEnd }) {
    input.classList.add('cursor-ew-resize', 'focus:cursor-text');
    input.addEventListener('pointerdown', e => {
        if (document.activeElement === input || e.button !== 0) return;
        if (e.offsetX > input.clientWidth - 14) return;   // the step arrows at the right edge (index.astro) stay native
        e.preventDefault();   // no focus yet: a click focuses on release, a drag never
        let last = e.clientX, value = Number(input.value) || 0, dragging = false, moved = 0;
        const rate = perPixel(value);
        input.setPointerCapture(e.pointerId);
        const move = ev => {
            const dx = ev.clientX - last;
            last = ev.clientX;
            moved += Math.abs(dx);
            if (!dragging) {
                if (moved < 3) return;
                dragging = true;
                onStart?.();
            }
            value = Math.min(max, Math.max(min, value + dx * rate * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1)));
            const shown = step > 0 ? Math.round(value / step) * step : value;
            input.value = fmt(shown);
            onDrag(shown);
        };
        const up = () => {
            input.removeEventListener('pointermove', move);
            input.removeEventListener('pointerup', up);
            input.removeEventListener('pointercancel', up);
            if (dragging) onEnd?.();
            else { input.focus(); input.select(); }
        };
        input.addEventListener('pointermove', move);
        input.addEventListener('pointerup', up);
        input.addEventListener('pointercancel', up);
    });
}

export function fmt(v) {
    return Math.abs(v) < 1e-9 ? "0" : String(Math.round(v * 100) / 100);
}

// --- Colour field with an own picker (instead of the native dialog, which follows the OS look) ---

/**
 * Colour field: swatch button; a click opens the picker popover in the panel style (saturation/brightness field,
 * hue bar, hex input). onInput while picking (live), onChange when a change is finished (pointer released, hex
 * confirmed, picker closed) – one undo step. `field.value` gets/sets the hex colour, `field.disabled` works.
 * @param {string} value '#rrggbb'
 * @param {{ onInput?: (hex: string) => void, onChange?: (hex: string) => void, className?: string, title?: string }} opts
 */
export function colorField(value, { onInput, onChange, className = 'w-full', title } = {}) {
    const field = document.createElement('button');
    field.type = 'button';
    field.className = `h-5 ${className} min-w-0 cursor-pointer rounded ring-1 ring-white/25 hover:ring-white/50 disabled:cursor-default disabled:opacity-40`;
    if (title) field.title = title;
    let current = normHex(value);
    Object.defineProperty(field, 'value', {
        get: () => current,
        set: v => { current = normHex(v); field.style.background = current; },
    });
    field.value = current;
    field.addEventListener('click', e => {
        e.stopPropagation();
        if (picker?.anchor === field) { closePicker(); return; }
        openColorPicker(field, field.value, {
            onInput: hex => { field.value = hex; onInput?.(hex); },
            onChange: hex => { field.value = hex; onChange?.(hex); },
        });
    });
    return field;
}

/**
 * Open the colour picker at `anchor` (e.g. a gradient stop marker) for `value`. onInput while picking,
 * onChange when a change is finished. Closes on Escape / pointer down outside.
 */
export function openColorPicker(anchor, value, { onInput, onChange } = {}) {
    openPicker(anchor, normHex(value), { onInput, onChange });
}

let picker = null;   // the open picker: { root, field, hsv, dirty, … }

function openPicker(anchor, value, callbacks) {
    closePicker();
    const root = document.createElement('div');
    root.className = 'fixed z-50 w-56 rounded-lg bg-black/75 p-2.5 text-xs text-white/90 shadow-2xl ring-1 ring-white/10 backdrop-blur-md select-none';
    root.innerHTML = `
        <div data-sv class="relative h-36 w-full cursor-crosshair overflow-hidden rounded ring-1 ring-white/10">
            <div class="absolute inset-0" style="background: linear-gradient(to right, #fff, rgba(255,255,255,0))"></div>
            <div class="absolute inset-0" style="background: linear-gradient(to top, #000, rgba(0,0,0,0))"></div>
            <div data-svh class="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow ring-2 ring-white"></div>
        </div>
        <div data-hue class="relative mt-2.5 h-3 cursor-pointer rounded ring-1 ring-white/10"
             style="background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)">
            <div data-hueh class="pointer-events-none absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white shadow ring-1 ring-black/40"></div>
        </div>
        <div class="mt-2.5 flex items-center gap-2">
            <div data-prev class="size-6 shrink-0 rounded ring-1 ring-white/20"></div>
            <input data-hex maxlength="7" spellcheck="false" class="${INPUT.replace('text-right tabular-nums', 'text-left font-mono')}" />
        </div>`;
    document.body.append(root);
    const $ = s => root.querySelector(s);
    const p = picker = { root, anchor, value, callbacks, hsv: hexToHsv(value), dirty: false, sv: $('[data-sv]'), svh: $('[data-svh]'), hue: $('[data-hue]'), hueh: $('[data-hueh]'), prev: $('[data-prev]'), hex: $('[data-hex]') };
    paintPicker();
    placePicker();

    const emit = () => {
        const hex = p.value = hsvToHex(p.hsv);
        p.prev.style.background = hex;
        if (document.activeElement !== p.hex) p.hex.value = hex;
        p.dirty = true;
        callbacks.onInput?.(hex);
    };
    const commit = () => {
        if (!p.dirty) return;
        p.dirty = false;
        callbacks.onChange?.(p.value);
    };
    p.commit = commit;
    const drag = (el, apply) => el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const at = ev => { const r = el.getBoundingClientRect(); apply(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height)); paintPicker(); emit(); };
        at(e);
        const up = () => { el.removeEventListener('pointermove', at); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); commit(); };
        el.addEventListener('pointermove', at);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
    });
    drag(p.sv, (x, y) => { p.hsv.s = x; p.hsv.v = 1 - y; });
    drag(p.hue, x => { p.hsv.h = Math.min(x, 0.9999) * 360; });
    p.hex.value = value;
    p.hex.oninput = () => {
        const v = p.hex.value.trim();
        if (/^#?[0-9a-f]{6}$/i.test(v)) { p.hsv = hexToHsv(normHex(v)); paintPicker(); emit(); }
    };
    p.hex.onkeydown = e => { if (e.key === 'Enter') { commit(); closePicker(); } };
    p.hex.onchange = commit;

    // close: pointer down outside, Escape, scroll of the page
    p.outside = e => { if (!root.contains(e.target) && e.target !== anchor) closePicker(); };
    p.key = e => { if (e.key === 'Escape') { e.stopPropagation(); closePicker(); } };
    window.addEventListener('pointerdown', p.outside, true);
    window.addEventListener('keydown', p.key, true);
    window.addEventListener('resize', closePicker);
}

function closePicker() {
    const p = picker;
    if (!p) return;
    picker = null;
    p.commit?.();
    window.removeEventListener('pointerdown', p.outside, true);
    window.removeEventListener('keydown', p.key, true);
    window.removeEventListener('resize', closePicker);
    p.root.remove();
}

function paintPicker() {
    const p = picker;
    const { h, s, v } = p.hsv;
    p.sv.style.background = `hsl(${h}, 100%, 50%)`;
    p.svh.style.left = `${s * 100}%`;
    p.svh.style.top = `${(1 - v) * 100}%`;
    p.svh.style.background = hsvToHex(p.hsv);
    p.hueh.style.left = `${h / 360 * 100}%`;
    p.prev.style.background = hsvToHex(p.hsv);
}

// below the field, above it if there is no room; inside the window
function placePicker() {
    const p = picker, r = p.anchor.getBoundingClientRect(), pr = p.root.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - pr.width - 8);
    p.root.style.left = `${left}px`;
    p.root.style.top = `${top}px`;
}

const clamp01 = v => Math.min(Math.max(v, 0), 1);
function normHex(v) {
    let h = String(v || '#000000').trim().toLowerCase();
    if (!h.startsWith('#')) h = '#' + h;
    if (/^#[0-9a-f]{3}$/.test(h)) h = '#' + [...h.slice(1)].map(c => c + c).join('');
    return /^#[0-9a-f]{6}$/.test(h) ? h : '#000000';
}
function hexToHsv(hex) {
    const n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s: max ? d / max : 0, v: max };
}
function hsvToHex({ h, s, v }) {
    const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
