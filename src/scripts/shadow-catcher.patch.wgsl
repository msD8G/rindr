						// RINDR shadow catcher – inserted by the Vite plugin in astro.config.mjs (see shadow-catcher.js).
						// Replaces the library's matte branch. A matte surface (the ground) hit by the camera ray
						// shows the background multiplied by the share of light that reaches it: one light
						// direction per sample (environment ∝ luminance · cos via rejection, or one of the lights,
						// chosen by its share of the unshadowed irradiance), one shadow ray, result 0 or 1 – the
						// mean over the samples is exactly (irradiance with occluders) / (irradiance without).
						// Seen in reflections (bounce > 0) it shows the dome floor (environment colour via
						// domeDirection) with the shadow – like the geometry dome in Blender. Without MIS: next
						// event estimation never reaches it (its shadow rays are blocked by the catcher), so the
						// light from below comes only through these hits.
						if ( materialInfo.matte != 0 ) {

							let scVertex = ${ sampleTrianglePointFn }( hitResult.barycoord, hitResult.indices.xyz );
							let scPos = ( objectInfo.matrixWorld * scVertex.position ).xyz;

							if ( ${ __SC.params }.w > 0.5 ) {

								let scParams = ${ __SC.params };
								let scLights = ${ __SC.lights };
								let scUp = vec3f( 0.0, 1.0, 0.0 );
								let scRand = ${ rand3 }( ${ RNG_INDEX_DIRECT_LIGHT_SAMPLE } );
								var scDir = vec3f( 0.0, 1.0, 0.0 );
								var scDist = ${ LIGHT_FAR_DISTANCE };
								var scWeight = 0.0;
								if ( scRand.x < scParams.x ) {

									// environment: direction ∝ luminance (importance sampling of the HDRI), accepted with
									// probability cos → distributed ∝ L · cos, every sample is simply visible (1) or not
									// (0) – an unshadowed ground is exactly 1, no noise. No accepted direction after
									// 16 tries (almost no light from above) → counts as lit.
									scWeight = 1.0;
									for ( var scTry = 0u; scTry < 16u; scTry ++ ) {

										let scR = ${ rand3 }( 100u + scTry );
										let scEnv = ${ sampleEnvDir }( scR.yz );
										if ( scEnv.pdf > 0.0 && scR.x < dot( scEnv.direction, scUp ) ) {

											scDir = scEnv.direction;
											scWeight = 2.0;   // marker: direction found → shadow ray
											break;

										}

									}
									scWeight = select( 0.0, 1.0, scWeight > 1.5 );
									if ( scWeight == 0.0 ) {

										scWeight = - 1.0;   // nothing found: lit without a shadow ray

									}

								} else {

									// a light, chosen by its share (scLights = probabilities in path tracer order)
									var scAcc = scParams.x;
									var scIndex = 0u;
									for ( var scI = 0u; scI < 4u; scI ++ ) {

										scIndex = scI;
										scAcc += scLights[ scI ];
										if ( scRand.x < scAcc ) {

											break;

										}

									}

									let scLight = ${ randomLightSampleFn }( scIndex, scPos, scRand.yz );
									scDir = scLight.direction;
									scDist = scLight.dist - ${ LIGHT_EPSILON };
									scWeight = select( 0.0, 1.0, scLight.pdf > 0.0 );

								}

								var scLit = select( 0.0, 1.0, scWeight < 0.0 );
								if ( scWeight > 0.0 ) {

									var scRay: ${ rayStruct };
									scRay.origin = ${ offsetRayOriginFunc }( scPos, scDir, scUp );
									scRay.direction = scDir;
									scRay.maxDist = scDist;
									var scHit: ${ raycastOutput };
									if ( ! ${ raycastFirstHitFn }( scRay, &scHit ) ) {

										scLit = scWeight;

									}

								}

								// strength 0…1
								let scShadow = mix( 1.0, scLit, scParams.z );
								let scLookup = ${ __DOME }( ray.origin, ray.direction, ${ rand1 }( 130u ) );
								// ground reflection / bad weather (ground-reflection.js): reflection share r, roughness,
								// darkening d – background × shadow × (1 − r) × d, the rest continues as reflection ray
								let scSurf = ${ __GROUND }( scPos, - ray.direction );
								var scBase = vec3f( 0.0 );   // what is seen of the ground without reflection
								if ( bounce == 0u ) {

									let scBg = ${ sampleBackground }( scLookup, ${ rand2 }( ${ RNG_INDEX_BACKGROUND_SAMPLE } ) );
									scBase = scBg.rgb * scShadow * scSurf.z;
									resultColor = vec4f( scBase * ( 1.0 - scSurf.x ), 1.0 );

								} else {

									scBase = ${ clampPathContributionFunc }( ${ sampleEnvColor }( scLookup ).rgb * scShadow * scSurf.z * throughputColor, bounce, clampDirect, clampIndirect );
									resultColor += vec4f( scBase * ( 1.0 - scSurf.x ), 0.0 );

								}
								if ( scSurf.x > 1e-3 ) {

									// only the model is mirrored (HDRI background hidden): count the ground as if the
									// reflection ray misses; if it hits something, that is taken back (top of the loop)
									if ( scSurf.w < 0.5 ) {

										scMirrorBg = scBase * scSurf.x;
										resultColor += vec4f( scMirrorBg, 0.0 );
										scMirrorPending = true;

									}

									// glossy around the mirror direction (spread ∝ roughness²), never into the ground
									var scRefl = reflect( ray.direction, scUp );
									let scRough = scSurf.y * scSurf.y;
									if ( scRough > 0.0 ) {

										let scU = ${ rand2 }( 120u );
										let scZ = 1.0 - 2.0 * scU.x;
										let scRr = sqrt( max( 0.0, 1.0 - scZ * scZ ) );
										let scPhi = 6.283185307 * scU.y;
										scRefl = normalize( scRefl + vec3f( scRr * cos( scPhi ), scRr * sin( scPhi ), scZ ) * scRough * 1.5 );

									}
									if ( scRefl.y < 1e-3 ) {

										scRefl = normalize( vec3f( scRefl.x, abs( scRefl.y ) + 1e-3, scRefl.z ) );

									}
									throughputColor *= scSurf.x;
									ray.origin = ${ offsetRayOriginFunc }( scPos, scRefl, scUp );
									ray.direction = scRefl;
									ray.maxDist = 0.0;
									bsdfPdf = 1e6;   // like a mirror: no next event estimation here, environment hits count fully
									isFullyTransmissive = false;
									${ rngNextBounce }();
									continue;

								}
								break;

							}

							// catcher inactive: invisible – continue behind it
							ray.origin = ${ offsetRayOriginFunc }( scPos, ray.direction, hitResult.normal );
							continue;

						}
