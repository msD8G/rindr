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

/** Message with one button (e.g. an error) */
export function messageDialog({ title, message }) {
    return show({ title, message, buttons: [{ label: t('dialog.ok'), value: true, primary: true, className: 'bg-white/15 text-white hover:bg-white/25' }] });
}

function show({ title, message, buttons }) {
    open?.close(false);
    return new Promise(resolve => {
        const root = document.createElement('div');
        root.dataset.dialog = '';
        root.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 text-xs text-white/90';
        const panel = document.createElement('div');
        panel.className = 'w-[min(26rem,100%)] overflow-hidden rounded-lg bg-black/60 shadow-2xl backdrop-blur-sm';
        panel.setAttribute('role', 'dialog');
        const head = document.createElement('div');
        head.className = 'border-b border-white/10 px-4 py-2.5 font-medium';
        head.textContent = title;
        const body = document.createElement('div');
        body.className = 'whitespace-pre-line px-4 py-3 text-white/80';
        body.textContent = message;
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

        const onKey = e => {
            if (e.key === 'Escape' || e.key === 'Enter') {
                e.preventDefault();
                e.stopImmediatePropagation();
                close(e.key === 'Enter' ? buttons.find(b => b.primary)?.value ?? true : buttons.length > 1 ? false : true);
            }
        };
        // click next to the panel = cancel; pointer events must not reach the viewer/other panels
        const onDown = e => { if (!panel.contains(e.target)) { e.stopImmediatePropagation(); close(buttons.length > 1 ? false : true); } };
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
