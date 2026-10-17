// RINDR cloud volumes – inserted into three-gpu-pathtracer's megakernel by the Vite plugin rindr-cloud
// (astro.config.mjs) right after the material of a hit is read; the interpolations are the kernel's helpers and
// __CLOUD (cloud-pt.js). Own random generator (PCG, seeded once per bounce): hundreds of draws per path.
						// RINDR cloud volume (clouds.js, cloud-pt.js)
						if ( materialInfo.fogVolume == 3 ) {

							let cvSlot = materialInfo.metalness;
							let cvScale = max( materialInfo.clearcoat, 1e-6 );
							let cvPuff = materialInfo.ior;
							let cvSigma = materialInfo.roughness * ${ __CLOUD.sigma }.0 / cvScale;
							let cvAlbedo = materialInfo.color;
							let cvG = materialInfo.anisotropy;
							let cvInv = objectInfo.inverseMatrixWorld;
							var cvRng = u32( ${ rand1 }( 190u ) * 4294967040.0 ) ^ ( bounce * 2654435761u );
							// entering through a front face: from the hit; a back face: the ray started inside
							var cvPos = select( ray.origin, ray.origin + ray.direction * hitResult.dist, hitResult.side > 0.0 );
							var cvDir = ray.direction;
							var cvScattered = false;
							var cvDone = false;
							var cvAlive = true;
							for ( var cvEvent = 0u; cvEvent < 64u; cvEvent ++ ) {

								// segment: until the box is left or a surface inside the cloud is reached
								let cvLo = ( cvInv * vec4f( cvPos, 1.0 ) ).xyz;
								let cvLd = ( cvInv * vec4f( cvDir, 0.0 ) ).xyz;
								var cvEnd = ${ __CLOUD.boxExit }( cvLo, cvLd );
								var cvRay: ${ rayStruct };
								cvRay.origin = cvPos + cvDir * ( 1e-4 * cvScale );
								cvRay.direction = cvDir;
								cvRay.maxDist = cvEnd;
								var cvHit: ${ raycastOutput };
								var cvSurface = false;
								if ( ${ raycastFirstHitFn }( cvRay, &cvHit ) ) {

									let cvHitMaterial = ( *materials )[ transforms[ cvHit.objectIndex ].materialIndex ];
									if ( cvHitMaterial.fogVolume != 3 && cvHit.dist < cvEnd ) {

										cvEnd = cvHit.dist;
										cvSurface = true;

									}

								}

								// delta tracking: free flight against the majorant, real collision with density / majorant;
								// where the shape is farther than the cloud reaches there is no density – jumped over
								var cvT = 0.0;
								var cvCollided = false;
								for ( var cvK = 0u; cvK < 512u; cvK ++ ) {

									let cvQ = cvPos + cvDir * cvT;
									let cvGap = ${ __CLOUD.gap }( ( cvInv * vec4f( cvQ, 1.0 ) ).xyz, cvSlot, cvScale, cvPuff );
									if ( cvGap > 0.004 * cvScale ) {

										cvT += cvGap;
										if ( cvT >= cvEnd ) {

											break;

										}
										continue;

									}

									cvRng = cvRng * 747796405u + 2891336453u;
									let cvU0 = ${ __CLOUD.pcg }( cvRng );
									cvT -= log( 1.0 - cvU0 ) / max( cvSigma, 1e-8 );
									if ( cvT >= cvEnd ) {

										break;

									}
									let cvP = cvPos + cvDir * cvT;
									let cvD = ${ __CLOUD.density }( ( cvInv * vec4f( cvP, 1.0 ) ).xyz, cvP, cvSlot, cvScale, cvPuff );
									cvRng = cvRng * 747796405u + 2891336453u;
									let cvU1 = ${ __CLOUD.pcg }( cvRng );
									if ( cvU1 < cvD ) {

										cvCollided = true;
										break;

									}

								}

								if ( ! cvCollided ) {

									// out of the box (or onto the surface inside): the path goes on from there
									cvPos = cvPos + cvDir * select( cvEnd + 1e-4 * cvScale, max( cvEnd - 1e-4 * cvScale, 0.0 ), cvSurface );
									cvDone = true;
									break;

								}

								// scattering event
								cvPos = cvPos + cvDir * cvT;
								throughputColor *= cvAlbedo;
								cvScattered = true;
								gsRough = true;
								gsCaustic = false;

								// next event estimation: one light or the environment
								if ( misEnabled != 0u && lightsDenom > 0.0 ) {

									cvRng = cvRng * 747796405u + 2891336453u;
									let cvL0 = ${ __CLOUD.pcg }( cvRng );
									cvRng = cvRng * 747796405u + 2891336453u;
									let cvL1 = ${ __CLOUD.pcg }( cvRng );
									cvRng = cvRng * 747796405u + 2891336453u;
									let cvL2 = ${ __CLOUD.pcg }( cvRng );
									let cvLightIndex = min( u32( cvL0 * lightsDenom ), u32( lightsDenom ) - 1u );
									var cvLight: ${ lightRecordStruct };
									if ( envActive && cvLightIndex == lightsCount ) {

										let cvEnv = ${ sampleEnvDir }( vec2f( cvL1, cvL2 ) );
										cvLight.direction = cvEnv.direction;
										cvLight.emission = cvEnv.color;
										cvLight.pdf = cvEnv.pdf;
										cvLight.dist = ${ LIGHT_FAR_DISTANCE };
										cvLight.lightType = ${ ENVIRONMENT_LIGHT_TYPE };

									} else {

										cvLight = ${ randomLightSampleFn }( cvLightIndex, cvPos, vec2f( cvL1, cvL2 ) );

									}
									if ( cvLight.pdf > 0.0 ) {

										let cvShadowMax = cvLight.dist - ${ LIGHT_EPSILON };
										//@glass-shadow cvPos | cvLight.direction | cvShadowMax | cvLight.direction | false
										if ( any( gsShadow > vec3f( 0.0 ) ) ) {

											let cvPhase = ${ __CLOUD.pdfHG }( dot( cvDir, cvLight.direction ), cvG );
											let cvLightPdf = cvLight.pdf / lightsDenom;
											let cvMis = select( 1.0, ${ misHeuristicFn }( cvLightPdf, cvPhase ), ${ isMISWeightLightFn }( cvLight.lightType ) && ! gsGlass );
											let cvDirect = throughputColor * cvLight.emission * cvPhase * cvMis * gsShadow / cvLightPdf;
											resultColor += vec4f( ${ clampPathContributionFunc }( cvDirect, bounce + 1u, clampDirect, clampIndirect ), 0.0 );

										}

									}

								}

								// new direction
								cvRng = cvRng * 747796405u + 2891336453u;
								let cvH0 = ${ __CLOUD.pcg }( cvRng );
								cvRng = cvRng * 747796405u + 2891336453u;
								let cvH1 = ${ __CLOUD.pcg }( cvRng );
								let cvNewDir = ${ __CLOUD.sampleHG }( cvDir, cvG, vec2f( cvH0, cvH1 ) );
								bsdfPdf = ${ __CLOUD.pdfHG }( dot( cvDir, cvNewDir ), cvG );
								minPdf = min( minPdf, bsdfPdf );
								cvDir = cvNewDir;

								// russian roulette after a few events (the albedo only ever lowers the throughput)
								if ( cvEvent >= 6u ) {

									let cvKeep = clamp( max( max( throughputColor.r, throughputColor.g ), throughputColor.b ), 0.05, 0.98 );
									cvRng = cvRng * 747796405u + 2891336453u;
									let cvRr = ${ __CLOUD.pcg }( cvRng );
									if ( cvRr > cvKeep ) {

										cvAlive = false;
										break;

									}
									throughputColor /= cvKeep;

								}

							}

							if ( ! cvDone || ! cvAlive ) {

								break;

							}

							ray.origin = cvPos;
							ray.direction = cvDir;
							ray.maxDist = 0.0;
							if ( cvScattered ) {

								isFullyTransmissive = false;

							} else {

								// no scattering: like a transparent pass – the bounce does not count
								if ( transparentBounce >= maxTransparentBounces ) {

									break;

								}
								transparentBounce ++;
								bounce --;

							}
							${ rngNextBounce }();
							continue;

						}

