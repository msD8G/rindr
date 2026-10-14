// Undo/redo (Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z).
//
// Every action is recorded *after* it has been executed via record(): { label, undo(), redo() }.
// Continuous changes (sliders, colour pickers) with the same mergeKey are merged into one step as
// long as less than MERGE_MS passes between two changes – undo stays that of the first change, redo
// becomes that of the last. While undo/redo run, nothing is recorded (the setters called during
// them would otherwise create steps themselves).
// transaction() merges several records into one step (e.g. create material + assign it).

const MERGE_MS = 1000;

export class History extends EventTarget {
    /** Events: 'change' (stack changed) */
    constructor({ limit = 50 } = {}) {
        super();
        this.limit = limit;
        this.undoStack = [];
        this.redoStack = [];
        this.applying = false;
        this._group = null;
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }

    /**
     * @param {{ label: string, undo: () => void, redo: () => void, mergeKey?: string }} step
     */
    record(step) {
        if (this.applying) return;
        if (this._group) { this._group.push(step); return; }
        const now = performance.now();
        const top = this.undoStack.at(-1);
        if (step.mergeKey && top && top.mergeKey === step.mergeKey && now - top.time < MERGE_MS && !this.redoStack.length) {
            top.redo = step.redo;
            top.time = now;
            return;
        }
        this.undoStack.push({ ...step, time: now });
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack.length = 0;
        this._emit();
    }

    /** Run fn; all steps recorded inside it become a single step */
    transaction(label, fn) {
        if (this._group || this.applying) return fn();
        const steps = this._group = [];
        try { return fn(); }
        finally {
            this._group = null;
            if (steps.length === 1) this.record({ ...steps[0], label });
            else if (steps.length) {
                this.record({
                    label,
                    undo: () => { for (let i = steps.length - 1; i >= 0; i--) steps[i].undo(); },
                    redo: () => steps.forEach(s => s.redo()),
                });
            }
        }
    }

    /** @returns {string|null} label of the undone step */
    undo() {
        const step = this.undoStack.pop();
        if (!step) return null;
        this._run(() => step.undo());
        this.redoStack.push(step);
        this._emit();
        return step.label;
    }

    redo() {
        const step = this.redoStack.pop();
        if (!step) return null;
        this._run(() => step.redo());
        step.time = 0;   // after redo, do not merge with the next change anymore
        this.undoStack.push(step);
        this._emit();
        return step.label;
    }

    clear() {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this._emit();
    }

    _run(fn) {
        this.applying = true;
        try { fn(); }
        catch (err) { console.error('[History]', err); }
        finally { this.applying = false; }
    }

    _emit() {
        this.dispatchEvent(new CustomEvent('change'));
    }
}
