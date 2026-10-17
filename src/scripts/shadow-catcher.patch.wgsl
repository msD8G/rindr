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

								var scLit = vec3f( select( 0.0, 1.0, scWeight < 0.0 ) );
								if ( scWeight > 0.0 ) {

									// shadow ray – through glass when glass shadows are transparent (glass-shadow.js)
									//@glass-shadow scPos | scDir | scDist | scUp | bounce == 0u
									scLit = gsShadow * scWeight;

								}

								// strength 0…1
								let scShadow = mix( vec3f( 1.0 ), scLit, scParams.z );
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
								// what continues from the ground: the reflection ray and/or a bounce ray for the light the model
								// throws onto the ground – with both, one of them per sample (each × 2)
								let scBounceOn = ${ __SC.bounce }.x > 0.0 && ${ __SC.bounce }.y > 0.0;
								let scMirrorOn = scSurf.x > 1e-3;
								let scBoth = scBounceOn && scMirrorOn;
								let scPick = select( 0.0, ${ rand1 }( 151u ), scBoth );
								let scScale = select( 1.0, 2.0, scBoth );
								if ( scMirrorOn && ( ! scBoth || scPick < 0.5 ) ) {

									// only the model is mirrored (HDRI background hidden): count the ground as if the
									// reflection ray misses; if it hits something, that is taken back (top of the loop)
									if ( scSurf.w < 0.5 ) {

										scMirrorBg = scBase * scSurf.x * scScale;
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
									throughputColor *= scSurf.x * scScale;
									ray.origin = ${ offsetRayOriginFunc }( scPos, scRefl, scUp );
									ray.direction = scRefl;
									ray.maxDist = 0.0;
									bsdfPdf = 1e6;   // like a mirror: no next event estimation here, environment hits count fully
									isFullyTransmissive = false;
									${ rngNextBounce }();
									continue;

								}
								if ( scBounceOn ) {

									// colour bleeding: a cosine-distributed ray upwards; only if it hits the model does the
									// path continue there (material, lights, further bounces – also back onto the ground, every
									// time a path meets it, like real geometry). Albedo = HDRI floor colour here (also with the
									// HDRI background hidden) × π / E (E = unshadowed irradiance, luminance): the ground acts as
									// a matte surface in the colour of the HDRI floor, ≤ 0.9 (no gain over the bounces); the
									// strength slider only scales the bounce seen by the camera. Sky and lights seen from the
									// ground are already in the shadow ratio (that ray simply ends).
									let scC = ${ rand2 }( 152u );
									let scS = sqrt( scC.x );
									let scPhiB = 6.283185307 * scC.y;
									let scDirB = vec3f( scS * cos( scPhiB ), sqrt( max( 1.0 - scC.x, 0.0 ) ), scS * sin( scPhiB ) );
									var scRayB: ${ rayStruct };
									scRayB.origin = ${ offsetRayOriginFunc }( scPos, scDirB, scUp );
									scRayB.direction = scDirB;
									scRayB.maxDist = 0.0;
									var scHitB: ${ raycastOutput };
									if ( ${ raycastFirstHitFn }( scRayB, &scHitB ) && ( *materials )[ transforms[ scHitB.objectIndex ].materialIndex ].matte == 0 ) {

										let scAlbedo = min( ${ sampleEnvColor }( scLookup ).rgb * ${ __SC.bounce }.y, vec3f( 0.9 ) );
										let scGain = select( 1.0, ${ __SC.bounce }.x, bounce == 0u );
										throughputColor *= scAlbedo * ( scGain * scSurf.z * ( 1.0 - scSurf.x ) * scScale );
										// a rough bounce: glass after it is a caustic path (glass-shadow.js, rindr-glass-shadow)
										gsRough = true;
										gsCaustic = false;
										ray.origin = scRayB.origin;
										ray.direction = scDirB;
										ray.maxDist = 0.0;
										bsdfPdf = max( scDirB.y, 1e-4 ) / 3.14159265;
										isFullyTransmissive = false;
										${ rngNextBounce }();
										continue;

									}

								}
								break;

							}

							// catcher inactive: invisible – continue behind it
							ray.origin = ${ offsetRayOriginFunc }( scPos, ray.direction, hitResult.normal );
							continue;

						}
