// Guide buffers of the motion denoiser (motion-denoise.js) from the path tracer's own scene data: one ray per pixel
// with the path tracer's camera (perspective or fisheye – FISHEYE_RAY), the same BVH, transforms and material
// records (incl. textures, normal maps, per-object colours, stand-in materials). Raster guides (the first version)
// did not match the fisheye, nor what mirrors and glass show.
//
// Mirrors and clear glass (smooth metal / transmission): the ray follows the reflection / refraction to the first
// rough surface ("primary surface replacement") – the guides then describe what the pixel shows, not the glass or
// mirror itself: reflections and things behind glass keep their edges. Position = virtual position along the
// camera ray at the travelled distance (for a planar mirror the mirror image – it reprojects correctly), normal
// mirrored along, albedo × tint of the chain (metal colour, glass colour).
//
// Outputs (storage textures, rows top-down like the path tracer's output):
//   position: rgba32float – xyz world position, w = 1 surface / 0 background (incl. matte = shadow catcher)
//   normal:   rgba16float – xyz world normal (background: direction it is seen in), w = circle of confusion of the
//             first surface (pixels, depth of field)
//   albedo:   rgba16float – rgb reflectance of the surface (demodulation: textures stay sharp), a = 1
import { StorageTexture, FloatType, HalfFloatType, RGBAFormat, NearestFilter, Matrix4, Vector2 } from 'three/webgpu';
import { uniform, globalId, textureStore } from 'three/tsl';
import { proxy, proxyFn, wgslTagFn, rayStruct, ndcToCameraRay } from 'three-mesh-bvh/webgpu';
import { offsetRayOriginFunc } from 'three-gpu-pathtracer/src/webgpu/nodes/utils.wgsl.js';
import { FISHEYE_RAY } from './fisheye.js';

const storage = type => {
    const t = new StorageTexture(1, 1);
    t.type = type;
    t.format = RGBAFormat;
    t.generateMipmaps = false;
    t.minFilter = t.magFilter = NearestFilter;
    return t;
};

export class GuideKernel {
    /** @param {{ maxChain?: number, specularRoughness?: number }} options */
    constructor({ maxChain = 4, specularRoughness = 0.1 } = {}) {
        this.position = storage(FloatType);
        this.normal = storage(HalfFloatType);
        this.albedo = storage(HalfFloatType);
        this.position.name = 'Guide position';
        this.normal.name = 'Guide normal';
        this.albedo.name = 'Guide albedo';
        this._size = new Vector2();
        this._bvhData = null;

        const p = this.params = {
            bvhData: { value: null },
            globalId,
            positionTarget: textureStore(this.position).toWriteOnly(),
            normalTarget: textureStore(this.normal).toWriteOnly(),
            albedoTarget: textureStore(this.albedo).toWriteOnly(),
            size: uniform(new Vector2()),
            invViewProj: uniform(new Matrix4()),
            cameraWorld: uniform(new Matrix4()),
            cocScale: uniform(0),           // aperture radius · focal length in pixels (0 = no depth of field)
            invFocus: uniform(0),           // 1 / focus distance
            maxChain: uniform(maxChain, 'uint'),
            specularRoughness: uniform(specularRoughness),
        };
        const raycastOutput = proxy('bvhData.value.fns.raycastFirstHit.outputType', p);
        const raycastFirstHit = proxyFn('bvhData.value.fns.raycastFirstHit', p);
        const sampleTrianglePoint = proxyFn('bvhData.value.fns.sampleTrianglePoint', p);
        const getSurfaceRecord = proxyFn('bvhData.value.fns.getSurfaceRecord', p);

        // same vertex/surface setup as the megakernel (PathTracerMegaKernel.js)
        const shader = wgslTagFn/* wgsl */`
            fn compute( globalId: vec3u, size: vec2u, maxChain: u32, specularRoughness: f32, cocScale: f32, invFocus: f32 ) -> void {

                if ( globalId.x >= size.x || globalId.y >= size.y ) {

                    return;

                }

                let transforms = &${ proxy('bvhData.value.storage.transforms', p) };
                let materials = &${ proxy('bvhData.value.storage.materials', p) };

                // pixel centre, ndc like the path tracer (row 0 = bottom)
                let uv = ( vec2f( globalId.xy ) + vec2f( 0.5 ) ) / vec2f( size );
                let ndc = uv * 2.0 - vec2f( 1.0 );
                var ray: ${ rayStruct };
                let isFisheye = ${ FISHEYE_RAY }( ndc, ${ p.cameraWorld }, &ray );
                if ( ! isFisheye ) {

                    ray = ${ ndcToCameraRay }( ndc, ${ p.invViewProj } );

                }
                ray.direction = normalize( ray.direction );

                let camPos = ( ${ p.cameraWorld } * vec4f( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
                let forward = normalize( ( ${ p.cameraWorld } * vec4f( 0.0, 0.0, - 1.0, 0.0 ) ).xyz );
                let primaryDir = ray.direction;
                var travelled = length( ray.origin - camPos );   // perspective rays start on the near plane
                var mirror = mat3x3f( 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0 );
                var tint = vec3f( 1.0 );
                var position = vec4f( 0.0 );
                var normal = vec4f( 0.0 );
                var albedo = vec4f( 1.0 );
                var firstDepth = - 1.0;
                var chain = 0u;

                for ( var i = 0u; i < 16u; i ++ ) {

                    var hit: ${ raycastOutput };
                    if ( ! ${ raycastFirstHit }( ray, &hit ) ) {

                        break;

                    }

                    travelled += hit.dist;
                    let objectInfo = transforms[ hit.objectIndex ];
                    var materialInfo = ( *materials )[ objectInfo.materialIndex ];

                    // matte (shadow catcher) seen directly: the path tracer shows the background there
                    if ( materialInfo.matte != 0 && chain == 0u ) {

                        break;

                    }

                    materialInfo.color *= objectInfo.color.rgb;
                    materialInfo.opacity *= objectInfo.color.a;

                    var vertexData = ${ sampleTrianglePoint }( hit.barycoord, hit.indices.xyz );
                    vertexData.normal = normalize( transpose( objectInfo.inverseMatrixWorld ) * vertexData.normal );
                    vertexData.tangent = vec4f( ( objectInfo.matrixWorld * vec4f( vertexData.tangent.xyz, 0.0 ) ).xyz, vertexData.tangent.w );
                    vertexData.position = objectInfo.matrixWorld * vertexData.position;
                    let surface = ${ getSurfaceRecord }( materialInfo, vertexData, hit.side, hit.normal, - ray.direction, 0.0 );

                    if ( firstDepth < 0.0 ) {

                        // depth of field: along the view direction (perspective), along the ray (fisheye: spherical focus)
                        firstDepth = select( dot( vertexData.position.xyz - camPos, forward ), travelled, isFisheye );

                    }

                    // mostly see-through (alpha): what lies behind is what the pixel shows
                    if ( surface.opacity < 0.5 ) {

                        ray.origin = ${ offsetRayOriginFunc }( vertexData.position.xyz, ray.direction, hit.normal );
                        continue;

                    }

                    // smooth mirror or clear glass: follow the ray
                    let smoothSurface = surface.roughness < specularRoughness;
                    let isMirror = smoothSurface && surface.metalness > 0.9;
                    let isGlass = smoothSurface && surface.transmission > 0.9;
                    if ( ( isMirror || isGlass ) && chain + 1u < maxChain ) {

                        chain ++;
                        tint *= surface.color;
                        let n = surface.normal;
                        if ( isMirror ) {

                            // vectors after the reflection → mirror space: Householder matrix I − 2·n·nᵀ
                            mirror = mirror * ( mat3x3f( 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0 ) - 2.0 * mat3x3f( n * n.x, n * n.y, n * n.z ) );
                            ray.direction = reflect( ray.direction, n );

                        } else if ( ! surface.thinWall ) {

                            let refracted = refract( ray.direction, n, surface.eta );
                            ray.direction = select( reflect( ray.direction, n ), normalize( refracted ), dot( refracted, refracted ) > 0.0 );

                        }
                        ray.origin = ${ offsetRayOriginFunc }( vertexData.position.xyz, ray.direction, hit.normal );
                        continue;

                    }

                    position = vec4f( camPos + primaryDir * travelled, 1.0 );
                    normal = vec4f( normalize( mirror * surface.normal ), 0.0 );
                    albedo = vec4f( tint * surface.color, 1.0 );
                    break;

                }

                // background – seen directly or in a mirror / through glass: the direction it is seen in (the filter
                // only mixes background with background of a similar direction – a chrome part's reflection does not
                // blur into the backdrop next to it, curved reflections keep their detail)
                if ( position.w == 0.0 ) {

                    normal = vec4f( ray.direction, 0.0 );

                }

                // circle of confusion of the first surface in pixels (background: at infinity)
                normal.w = select( cocScale * invFocus, cocScale * abs( invFocus - 1.0 / max( firstDepth, 1e-6 ) ), firstDepth > 0.0 );

                let texel = vec2u( globalId.x, size.y - 1u - globalId.y );
                textureStore( ${ p.positionTarget }, texel, position );
                textureStore( ${ p.normalTarget }, texel, normal );
                textureStore( ${ p.albedoTarget }, texel, albedo );

            }
        `;
        this._fn = shader(p);
        this.kernel = null;
    }

    /** Shader source changes (new scene data): build a new compute node */
    _build() {
        const node = this._fn.context({});
        node.parameters = this._fn.parameters;
        this.kernel = node.computeKernel([8, 8, 1]);
    }

    /**
     * Prepare the kernel for the path tracer's current scene data + size + camera. Returns the compute node to
     * dispatch and its dispatch size.
     * @param {object} bvhData path tracer scene data (megakernel's bvhData)
     */
    update(bvhData, width, height, camera) {
        const p = this.params;
        if (bvhData !== this._bvhData) {
            this._bvhData = bvhData;
            p.bvhData.value = bvhData;
            this._build();
        }
        if (this._size.x !== width || this._size.y !== height) {
            this._size.set(width, height);
            for (const key of ['position', 'normal', 'albedo']) {
                const old = this[key];
                const t = this[key] = old.clone();
                old.dispose();
                t.setSize(width, height);
                p[`${key}Target`].value = t;
            }
        }
        p.size.value.set(width, height);
        camera.updateMatrixWorld();
        p.invViewProj.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
        p.cameraWorld.value.copy(camera.matrixWorld);
        // depth of field (PhysicalCamera: aperture radius bokehSize · 0.5e-3, as in the library's camera shim)
        const radius = (camera.bokehSize ?? 0) * 0.5e-3;
        const focalPx = height / 2 / Math.tan((camera.fov ?? 50) * Math.PI / 360);
        p.cocScale.value = radius > 0 && camera.focusDistance > 0 ? radius * focalPx : 0;
        p.invFocus.value = camera.focusDistance > 0 ? 1 / camera.focusDistance : 0;
        return { kernel: this.kernel, dispatch: [Math.ceil(width / 8), Math.ceil(height / 8), 1] };
    }

    dispose() {
        this.position.dispose();
        this.normal.dispose();
        this.albedo.dispose();
    }
}
