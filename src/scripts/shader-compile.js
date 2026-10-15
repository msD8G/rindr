// renderer.compileAsync() that compiles for the renderer state at the time of the call.
//
// three.js r186: compileAsync collects the objects synchronously, then builds their nodes one by one between
// frames – and node building reads the renderer's state at that later moment (render target → MRT/output
// branch, getMRT(), tone mapping, output colour space). Called inside a pass setup (denoiser albedo/normal MRT,
// lens target) and restored right after, the later builds saw another state: wrong shaders for the context
// ("Color target has no corresponding fragment stage output").
// Here the state of the call is recorded per render context; NodeManager.getForRenderAsync builds objects of
// such a context synchronously under that state (one object per step – compileAsync pauses between objects,
// the pipelines are still created asynchronously).

const jobs = new Map();   // RenderContext -> { state, count }
const patched = new WeakSet();

const captureState = r => ({
    target: r.getRenderTarget(), face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(),
    mrt: r.getMRT(), toneMapping: r.toneMapping, outputColorSpace: r.outputColorSpace,
});

function applyState(r, s) {
    r.setRenderTarget(s.target, s.face, s.mip);
    r.setMRT(s.mrt);
    r.toneMapping = s.toneMapping;
    r.outputColorSpace = s.outputColorSpace;
}

function patch(renderer) {
    if (patched.has(renderer)) return;
    patched.add(renderer);
    const nodes = renderer._nodes;
    const getForRenderAsync = nodes.getForRenderAsync.bind(nodes);
    nodes.getForRenderAsync = renderObject => {
        const job = jobs.get(renderObject.context);
        if (!job) return getForRenderAsync(renderObject);
        const saved = captureState(renderer);
        applyState(renderer, job.state);
        try {
            return Promise.resolve(nodes.getForRender(renderObject));
        } finally {
            applyState(renderer, saved);
        }
    };
}

/** renderer.compileAsync(scene, camera) for the current renderer state (target, MRT, tone mapping, colour space) */
export function compileAsync(renderer, scene, camera) {
    patch(renderer);
    // the render context compileAsync uses (Renderer.compileAsync: frame buffer target or the set target)
    const useFrameBufferTarget = renderer.needsFrameBufferTarget && renderer.getRenderTarget() === null;
    const target = useFrameBufferTarget ? renderer._getFrameBufferTarget() : (renderer.getRenderTarget() || renderer.getOutputRenderTarget());
    const context = renderer._renderContexts.get(target, renderer.getMRT());
    const job = jobs.get(context) ?? { state: captureState(renderer), count: 0 };
    job.state = captureState(renderer);
    job.count++;
    jobs.set(context, job);
    const done = () => { if (--job.count === 0 && jobs.get(context) === job) jobs.delete(context); };
    let promise;
    try {
        promise = renderer.compileAsync(scene, camera);
    } catch (err) {
        done();
        throw err;
    }
    return promise.finally(done);
}
