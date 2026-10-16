// Soft transitions of the whole picture (user's wish: "a smooth experience" – HDRI change, lens effects, depth of
// field, materials, view mode …, every view mode): each frame the finished image (before highlight and gizmo) is
// copied; on a change (begin()) the last one is held and faded out over the new frames (TRANSITION.ms).
// The path tracer's own image stages fade separately (image-fade.js) – this is for changes of the scene/settings.
//
// Plain WebGPU, not three.js: the canvas texture is copied raw (canvas configured with COPY_SRC) and the blend is
// written straight into it by an own render pass – three.js draws into the canvas through its multisampled buffer,
// whose resolve replaced the canvas content (blending over the finished image was impossible that way).
// WebGL2 fallback: no transitions.

const SHADER = /* wgsl */`
    @group( 0 ) @binding( 0 ) var current: texture_2d<f32>;
    @group( 0 ) @binding( 1 ) var held: texture_2d<f32>;
    @group( 0 ) @binding( 2 ) var<uniform> opacity: vec4f;

    @vertex
    fn vs( @builtin( vertex_index ) i: u32 ) -> @builtin( position ) vec4f {

        let p = array( vec2f( - 1.0, - 1.0 ), vec2f( 3.0, - 1.0 ), vec2f( - 1.0, 3.0 ) );
        return vec4f( p[ i ], 0.0, 1.0 );

    }

    @fragment
    fn fs( @builtin( position ) position: vec4f ) -> @location( 0 ) vec4f {

        let texel = vec2i( position.xy );
        return mix( textureLoad( current, texel, 0 ), textureLoad( held, texel, 0 ), opacity.x );

    }
`;

export class ScreenFade {
    /** @param {import('three/webgpu').WebGPURenderer} renderer @param {{ ms?: number }} options */
    constructor(renderer, { ms = 300 } = {}) {
        this.renderer = renderer;
        this.ms = ms;
        this.enabled = Boolean(renderer.backend?.isWebGPUBackend);
        this._last = null;        // copy of the last shown frame
        this._held = null;        // frame faded out during a transition
        this._scratch = null;     // this frame before blending
        this._start = -1;         // transition start (performance.now), -1 = none
        this._captured = false;   // a frame was copied since the last begin()
        this._pipeline = null;
        this._uniform = null;
    }

    get active() {
        return this._start >= 0;
    }

    /** A change is about to show: hold the last frame and fade it out over the next ones */
    begin() {
        if (!this.enabled || !this._last || !this.ms) return;
        // the held image is the last shown frame (during a transition: already blended – no jump when changes
        // follow each other); several changes before the next frame keep the same one
        if (this._captured) [this._last, this._held] = [this._held, this._last];
        this._captured = false;
        this._start = performance.now();
    }

    /** End of a frame (canvas holds the finished image): blend the held frame over it while a transition runs
     *  (overlay = false: not into this frame, e.g. image export), then keep a copy of what is shown */
    frame(overlay = true) {
        if (!this.enabled) return;
        const device = this.renderer.backend.device, canvas = this.renderer.backend.context?.getCurrentTexture?.();
        if (!device || !canvas) return;
        const w = canvas.width, h = canvas.height, format = canvas.format;
        const fits = t => t && t.width === w && t.height === h && t.format === format;
        const encoder = device.createCommandEncoder();
        if (this._start >= 0) {
            const t = (performance.now() - this._start) / this.ms;
            if (t >= 1 || !fits(this._held)) this._start = -1;
            else if (overlay) {
                const s = Math.min(Math.max(t, 0), 1);
                this._blend(device, encoder, canvas, 1 - s * s * (3 - 2 * s));   // smoothstep
            }
        }
        if (!fits(this._last)) {
            this._last?.destroy();
            this._last = device.createTexture({ size: [w, h], format,
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
        }
        encoder.copyTextureToTexture({ texture: canvas }, { texture: this._last }, [w, h]);
        device.queue.submit([encoder.finish()]);
        this._captured = true;
    }

    // canvas = mix(canvas, held, opacity): the canvas is copied first (a pass cannot read its own target)
    _blend(device, encoder, canvas, opacity) {
        const { width: w, height: h, format } = canvas;
        if (!this._pipeline || this._pipelineFormat !== format) {
            const module = device.createShaderModule({ code: SHADER, label: 'ScreenFade' });
            this._pipeline = device.createRenderPipeline({
                label: 'ScreenFade', layout: 'auto',
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format }] },
                primitive: { topology: 'triangle-list' },
            });
            this._pipelineFormat = format;
            this._uniform ??= device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        }
        const s = this._scratch;
        if (!s || s.width !== w || s.height !== h || s.format !== format) {
            s?.destroy();
            this._scratch = device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
        }
        encoder.copyTextureToTexture({ texture: canvas }, { texture: this._scratch }, [w, h]);
        device.queue.writeBuffer(this._uniform, 0, new Float32Array([opacity, 0, 0, 0]));
        const bindGroup = device.createBindGroup({
            layout: this._pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this._scratch.createView() },
                { binding: 1, resource: this._held.createView() },
                { binding: 2, resource: { buffer: this._uniform } },
            ],
        });
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: canvas.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    }
}
