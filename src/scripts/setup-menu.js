// Setup menu (gear in the toolbar): sections on the left, their options on the right.
// Same style as the other panels (black, translucent, blur, rounded, no outline).
//
//   const menu = new SetupMenu(element, title, { onClose });   // onClose: ✕ in the header
//   const s = menu.addSection('pt', 'Path tracing');
//   s.toggle(label, get, set)                → control
//   s.range(label, get, set, min, max, step) → control (slider + number field, applies live)
//   s.select(label, options, get, set)       → control (options: [{ label, value }])
//   s.text(label, get, set, { placeholder, mask }) → control (applies on Enter/leaving the field;
//                                              mask(value): shown instead of the value, field empties on focus)
//   s.button(label, onClick), s.heading(text), s.hint(text)
//   control.refresh() reads the value again, control.enable(bool); menu.refresh() refreshes all.
//   menu.onChange: called right before a switch, dropdown or text field applies a value (viewer: soft transition
//   of the picture, screen-fade.js) – not for sliders, they apply live while dragging.

import { t } from './i18n.js';

const INPUT = 'w-14 shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-right tabular-nums text-white outline-none focus:bg-white/20';
const ICON_CLOSE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const NAV = 'w-full rounded px-2.5 py-1.5 text-left transition-colors';
const NAV_IDLE = 'text-white/70 hover:bg-white/10 hover:text-white';
const NAV_ACTIVE = 'bg-sky-500/30 text-white';

const el = (tag, cls = '', text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};

export class SetupMenu {
    constructor(root, title, { onClose } = {}) {
        this.root = root;
        this.controls = [];
        this.sections = new Map();
        this.current = null;
        // header like the scene graph's, below it sections left, options right
        root.classList.add('flex-col');
        const header = el('div', 'flex shrink-0 items-center border-b border-white/10 px-3 py-2');
        header.append(el('span', 'flex-1 font-medium', title));
        if (onClose) {
            const x = el('button', 'text-white/50 hover:text-white');
            x.innerHTML = ICON_CLOSE;
            x.type = 'button';
            x.title = t('setup.close');
            x.addEventListener('click', onClose);
            header.append(x);
        }
        const body = el('div', 'flex min-h-0 flex-1');
        this.nav = el('nav', 'flex w-40 shrink-0 flex-col gap-0.5 border-r border-white/10 p-2');
        this.content = el('div', 'min-w-0 flex-1 overflow-auto p-3');
        body.append(this.nav, this.content);
        root.append(header, body);
    }

    addSection(id, title) {
        const item = el('button', `${NAV} ${NAV_IDLE}`, title);
        item.type = 'button';
        item.addEventListener('click', () => this.show(id));
        const page = el('div', 'flex flex-col gap-1');
        page.hidden = true;
        this.nav.append(item);
        this.content.append(page);
        this.sections.set(id, { item, page });
        if (!this.current) this.show(id);
        return new Section(this, page);
    }

    show(id) {
        const s = this.sections.get(id);
        if (!s) return;
        this.current = id;
        for (const [key, { item, page }] of this.sections) {
            item.className = `${NAV} ${key === id ? NAV_ACTIVE : NAV_IDLE}`;
            page.hidden = key !== id;
        }
    }

    refresh() {
        this.controls.forEach(c => c.refresh());
    }
}

class Section {
    constructor(menu, page) {
        this.menu = menu;
        this.page = page;
    }

    _row(label, ...inputs) {
        const row = el('div', 'flex min-h-7 items-center gap-3');
        row.append(el('span', 'w-36 shrink-0 text-white/70', label), ...inputs);
        this.page.append(row);
        return row;
    }

    _control(row, refresh, inputs) {
        const control = {
            refresh,
            enable(on = true) {
                row.classList.toggle('opacity-40', !on);
                inputs.forEach(i => { i.disabled = !on; });
                return control;
            },
        };
        refresh();
        this.menu.controls.push(control);
        return control;
    }

    heading(text) {
        this.page.append(el('div', 'mt-3 mb-1 border-t border-white/10 pt-3 font-medium text-white/90', text));
    }

    /** Free content (e.g. the about page) */
    append(node) {
        this.page.append(node);
    }

    hint(text) {
        this.page.append(el('div', 'mt-1 text-white/40', text));
    }

    /** On/off switch */
    toggle(label, get, set) {
        const sw = el('button', 'relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:cursor-default');
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        const knob = el('span', 'absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow transition-transform');
        sw.append(knob);
        const row = this._row(label, sw);
        const refresh = () => {
            const on = !!get();
            sw.setAttribute('aria-checked', String(on));
            sw.classList.toggle('bg-sky-500', on);
            sw.classList.toggle('bg-white/20', !on);
            knob.classList.toggle('translate-x-3', on);
        };
        sw.addEventListener('click', () => { this.menu.onChange?.(); set(!get()); refresh(); });
        return this._control(row, refresh, [sw]);
    }

    /** Slider + number field; applies while dragging */
    range(label, get, set, min, max, step) {
        const decimals = Math.max(0, -Math.floor(Math.log10(step)));
        const slider = el('input', 'min-w-0 flex-1 accent-sky-400');
        Object.assign(slider, { type: 'range', min, max, step });
        const number = el('input', INPUT);
        Object.assign(number, { type: 'number', min, max, step });
        const row = this._row(label, slider, number);
        const refresh = () => {
            const v = Number(get());
            slider.value = v;
            if (document.activeElement !== number) number.value = v.toFixed(decimals);
        };
        const apply = v => {
            if (!Number.isFinite(v)) return;
            set(Math.min(max, Math.max(min, v)));
            refresh();
        };
        slider.addEventListener('input', () => apply(Number(slider.value)));
        number.addEventListener('change', () => apply(Number(number.value)));
        number.addEventListener('keydown', e => { if (e.key === 'Enter') number.blur(); });
        return this._control(row, refresh, [slider, number]);
    }

    /** Dropdown; options: [{ label, value }] */
    select(label, options, get, set) {
        const select = el('select', 'min-w-0 flex-1 cursor-pointer rounded bg-white/10 px-1.5 py-0.5 text-white outline-none focus:bg-white/20');
        for (const o of options) {
            const option = new Option(o.label, o.value);
            option.className = 'bg-neutral-900';
            select.append(option);
        }
        const row = this._row(label, select);
        const refresh = () => { select.value = get(); };
        select.addEventListener('change', () => { this.menu.onChange?.(); set(select.value); });
        return this._control(row, refresh, [select]);
    }

    /** Text field; with mask (secrets like API keys) only the masked value is shown, never the value */
    text(label, get, set, { placeholder = '', mask } = {}) {
        const input = el('input', 'min-w-0 flex-1 rounded bg-white/10 px-1.5 py-0.5 text-white outline-none placeholder:text-white/30 focus:bg-white/20');
        Object.assign(input, { type: 'text', autocomplete: 'off', spellcheck: false, placeholder });
        if (mask) input.setAttribute('data-1p-ignore', '');   // no password manager suggestions
        const row = this._row(label, input);
        const shown = () => (mask ? mask(get()) : get()) || '';
        const refresh = () => { if (document.activeElement !== input) input.value = shown(); };
        if (mask) input.addEventListener('focus', () => { input.value = ''; });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') { e.stopPropagation(); input.value = shown(); input.blur(); }
        });
        input.addEventListener('blur', () => {
            const v = input.value.trim();
            if (mask ? v && v !== shown() : v !== get()) { this.menu.onChange?.(); set(v); }
            input.value = shown();
        });
        return this._control(row, refresh, [input]);
    }

    button(label, onClick) {
        const button = el('button', 'mt-1 self-start rounded bg-white/10 px-3 py-1 text-white hover:bg-white/20 disabled:opacity-40', label);
        button.type = 'button';
        button.addEventListener('click', onClick);
        this.page.append(button);
        return {
            refresh() {},
            enable(on = true) { button.disabled = !on; },
        };
    }
}
