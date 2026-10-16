// Dialogs inside the interface instead of the browser's confirm()/alert(): same style as the other panels
// (black, translucent, blur, rounded, no outline), centred, without darkening the viewer.
// Enter = confirm, Esc or a click next to it = cancel. Returns a promise.
import { t } from './i18n.js';

const BUTTON = 'rounded px-3 py-1 outline-none transition-colors';
let open = null;   // only one dialog at a time

/** Is a dialog open? (other panels must not react to its clicks/keys) */
export const dialogOpen = () => !!open;

/**
 * Question with two buttons.
 * @param {{ title: string, message: string, confirmLabel?: string, danger?: boolean }} o
 * @returns {Promise<boolean>}  true = confirmed
 */
export function confirmDialog({ title, message, confirmLabel = t('dialog.ok'), danger = false }) {
    return show({ title, message, buttons: [
        { label: t('dialog.cancel'), value: false, className: 'bg-white/10 text-white/80 hover:bg-white/20' },
        { label: confirmLabel, value: true, primary: true, className: danger ? 'bg-red-500/80 text-white hover:bg-red-500' : 'bg-sky-500/80 text-white hover:bg-sky-500' },
    ] });
}

const KIND = {
    primary: 'bg-sky-500/80 text-white hover:bg-sky-500',
    secondary: 'bg-white/15 text-white hover:bg-white/25',
    cancel: 'bg-white/10 text-white/80 hover:bg-white/20',
    danger: 'bg-red-500/80 text-white hover:bg-red-500',
};
const ICONS = {
    warning: '<svg viewBox="0 0 20 20" class="size-4 shrink-0 fill-amber-400"><path d="M10 2.2 1.3 17.3h17.4L10 2.2Zm-.9 5.3h1.8v4.9H9.1V7.5Zm0 6.3h1.8v1.8H9.1v-1.8Z"/></svg>',
    info: '<svg viewBox="0 0 20 20" class="size-4 shrink-0 fill-sky-400"><path d="M10 1.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4Zm.9 12.6H9.1V8.8h1.8v5.6Zm0-7.2H9.1V5.4h1.8v1.8Z"/></svg>',
};

/**
 * Question with several answers, optional icon ('warning' | 'info') and facts below the text (label/value rows,
 * e.g. memory needed vs. device memory). Esc / a click next to it → the button with `cancel: true` (or null).
 * @param {{ title: string, message: string, icon?: string, facts?: [string, string][],
 *   buttons: { label: string, value: any, kind?: 'primary'|'secondary'|'cancel'|'danger', cancel?: boolean }[] }} o
 */
export function choiceDialog({ title, message, icon, facts, buttons }) {
    const cancel = buttons.find(b => b.cancel);
    return show({ title, message, icon, facts, cancelValue: cancel ? cancel.value : null,
        buttons: buttons.map(b => ({ ...b, primary: b.kind === 'primary', className: KIND[b.kind || 'secondary'] })) });
}

/** Message with one button (e.g. an error) */
export function messageDialog({ title, message }) {
    return show({ title, message, buttons: [{ label: t('dialog.ok'), value: true, primary: true, className: 'bg-white/15 text-white hover:bg-white/25' }] });
}

function show({ title, message, buttons, icon, facts, cancelValue }) {
    open?.close(false);
    return new Promise(resolve => {
        const root = document.createElement('div');
        root.dataset.dialog = '';
        root.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 text-xs text-white/90';
        const panel = document.createElement('div');
        panel.className = 'w-[min(26rem,100%)] overflow-hidden rounded-lg bg-black/60 shadow-2xl backdrop-blur-sm';
        panel.setAttribute('role', 'dialog');
        const head = document.createElement('div');
        head.className = 'flex items-center gap-2 border-b border-white/10 px-4 py-2.5 font-medium';
        if (ICONS[icon]) head.insertAdjacentHTML('beforeend', ICONS[icon]);
        head.append(document.createTextNode(title));
        const body = document.createElement('div');
        body.className = 'whitespace-pre-line px-4 py-3 text-white/80';
        body.textContent = message;
        if (facts?.length) {
            const grid = document.createElement('div');
            grid.className = 'mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded bg-white/5 px-2.5 py-1.5 whitespace-normal';
            for (const [label, value] of facts) {
                const l = document.createElement('span');
                l.className = 'text-white/50';
                l.textContent = label;
                const v = document.createElement('span');
                v.className = 'text-right tabular-nums text-white/90';
                v.textContent = value;
                grid.append(l, v);
            }
            body.append(grid);
        }
        const foot = document.createElement('div');
        foot.className = 'flex justify-end gap-2 px-4 pb-3';
        let primary = null;
        for (const b of buttons) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = `${BUTTON} ${b.className}`;
            el.textContent = b.label;
            el.onclick = () => close(b.value);
            if (b.primary) primary = el;
            foot.append(el);
        }
        panel.append(head, body, foot);
        root.append(panel);
        document.body.append(root);

        const dismissed = cancelValue !== undefined ? cancelValue : buttons.length > 1 ? false : true;
        const onKey = e => {
            if (e.key === 'Escape' || e.key === 'Enter') {
                e.preventDefault();
                e.stopImmediatePropagation();
                close(e.key === 'Enter' ? buttons.find(b => b.primary)?.value ?? true : dismissed);
            }
        };
        // click next to the panel = cancel; pointer events must not reach the viewer/other panels
        const onDown = e => { if (!panel.contains(e.target)) { e.stopImmediatePropagation(); close(dismissed); } };
        window.addEventListener('keydown', onKey, true);
        root.addEventListener('pointerdown', onDown);
        function close(value) {
            if (open !== self) return;
            open = null;
            window.removeEventListener('keydown', onKey, true);
            root.remove();
            resolve(value);
        }
        const self = { close };
        open = self;
        primary?.focus();
    });
}
