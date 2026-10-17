											// RINDR glass shadows – inserted by the Vite plugin in astro.config.mjs (see glass-shadow.js), once for
											// next event estimation, once for the shadow catcher. In: $ORIGIN, $DIR, $MAXDIST (0 = unlimited),
											// $NORMAL, $PRIMARY (camera ray hit: colour fringe). Out: gsShadow (light transmitted to this point),
											// gsGlass (through glass, not blocked).
											var gsShadow = vec3f( 1.0 );
											var gsGlass = false;
											{

												let gsMode = ${ __GS.mode };
												// colour fringe: the path's wavelength (uniform over the spectrum, its colour weight has an
												// expected value of 1 per channel); spread = relative IOR difference blue ↔ red
												let gsSpread = select( 0.0, ${ __GS.fringe }, gsMode == 1u && ( $PRIMARY ) );
												let gsLambda = abs( dispersionWavelength );
												let gsBand = clamp( ( 550.0 - gsLambda ) / 300.0, - 0.5, 0.5 );   // visible 400 … 700 nm → +½ … −½ (blue bent most)
												var gsT0 = vec3f( 1.0 );
												var gsT1 = vec3f( 1.0 );
												var gsDev = vec3f( 0.0 );   // direction difference of this wavelength behind the glass (pass 0)
												var gsDist = - 1.0;         // distance to the first glass surface (fringe fade)
												var gsOpaque = false;
												var gsPasses = 1u;
												for ( var gsPass = 0u; gsPass < gsPasses; gsPass ++ ) {

													var gsDir = $DIR;
													if ( gsPass == 1u ) {

														// this wavelength arrives along a slightly different line: start against its deviation
														gsDir = normalize( gsDir - gsDev );

													}

													var gsRay: ${ rayStruct };
													gsRay.origin = ${ offsetRayOriginFunc }( $ORIGIN, gsDir, $NORMAL );
													gsRay.direction = gsDir;
													gsRay.maxDist = $MAXDIST;
													var gsT = vec3f( 1.0 );
													var gsTravel = 0.0;
													var gsBlocked = false;
													for ( var gsI = 0u; gsI < 16u; gsI ++ ) {

														var gsHit: ${ raycastOutput };
														if ( ! ${ raycastFirstHitFn }( gsRay, &gsHit ) ) {

															break;

														}

														let gsObject = transforms[ gsHit.objectIndex ];
														let gsMaterial = ( *materials )[ gsObject.materialIndex ];
														if ( gsMode == 0u || gsMaterial.transmission <= 0.0 || gsMaterial.matte != 0 || gsI == 15u ) {

															gsBlocked = true;
															break;

														}

														gsTravel += gsHit.dist;
														if ( gsPass == 0u && gsDist < 0.0 ) {

															gsDist = gsTravel;

														}

														// smooth normal, facing against the ray
														let gsVertex = ${ sampleTrianglePointFn }( gsHit.barycoord, gsHit.indices.xyz );
														var gsN = normalize( ( transpose( gsObject.inverseMatrixWorld ) * gsVertex.normal ).xyz );
														gsN = select( gsN, - gsN, dot( gsN, gsDir ) > 0.0 );

														// Fresnel transmission as seen from outside the glass – the ray is not bent, so evaluating an
														// exit face with the straight direction from inside gave total internal reflection for every
														// oblique light (a slab at 45° turned black); refracted, the exit angle inside matches the
														// entry angle outside (slab, sphere) and the transmission is the same both ways
														let gsThin = gsMaterial.thinWall != 0;
														let gsEntering = gsHit.side > 0.0 || gsThin;
														let gsIor = max( gsMaterial.ior, 1.0 );
														let gsEta = 1.0 / gsIor;
														let gsCos = clamp( dot( - gsDir, gsN ), 0.0, 1.0 );
														let gsCosT = sqrt( max( 1.0 - gsEta * gsEta * ( 1.0 - gsCos * gsCos ), 0.0 ) );
														let gsRs = ( gsEta * gsCos - gsCosT ) / ( gsEta * gsCos + gsCosT );
														let gsRp = ( gsCos - gsEta * gsCosT ) / ( gsCos + gsEta * gsCosT );
														let gsFresnel = clamp( 0.5 * ( gsRs * gsRs + gsRp * gsRp ), 0.0, 1.0 );
														var gsPassed = gsMaterial.transmission * ( 1.0 - gsFresnel );
														if ( gsThin ) {

															gsPassed *= 1.0 - gsFresnel;   // both faces of a thin wall at once

														} else {

															// light bent away: the more an oblique face would turn the ray, the less of the light on
															// this line arrives here (it lands elsewhere) – structure and dark rims in the shadow
															// instead of a plain grey filter; cos of the bend angle ^ 6
															let gsTurn = clamp( dot( refract( gsDir, gsN, gsEta ), gsDir ), 0.0, 1.0 );
															let gsTurn2 = gsTurn * gsTurn;
															gsPassed *= gsTurn2 * gsTurn2 * gsTurn2;

														}

														if ( gsEntering ) {

															gsT *= gsPassed * gsMaterial.color * gsObject.color.rgb;

														} else {

															gsT *= gsPassed * ${ transmissionAttenuationFunc }( gsHit.dist, gsMaterial.attenuationColor, gsMaterial.attenuationDistance );

														}

														// dispersion: how much farther this wavelength is bent than the mean one at the first face,
														// twice (like a prism: in and out). Physically a flat pane cancels out (in and out parallel)
														// – then most glass would show no fringe at all; this is the look, not the physics
														// rough transmission (frosted glass, the wax/jelly stand-ins) scatters – no prism there
														let gsSpreadHere = gsSpread * ( 1.0 - smoothstep( 0.1, 0.4, gsMaterial.roughness ) );
														if ( gsPass == 0u && gsSpreadHere > 0.0 && gsDist == gsTravel ) {

															let gsEtaBand = 1.0 / max( gsIor * ( 1.0 + gsSpreadHere * gsBand ), 1.0 );
															gsDev = 2.0 * ( refract( gsDir, gsN, gsEtaBand ) - refract( gsDir, gsN, gsEta ) );

														}

														if ( max( max( gsT.r, gsT.g ), gsT.b ) < 1e-3 ) {

															gsBlocked = true;
															break;

														}

														let gsPos = gsRay.origin + gsRay.direction * gsHit.dist;
														gsRay.origin = ${ offsetRayOriginFunc }( gsPos, gsDir, gsHit.normal );
														if ( gsRay.maxDist > 0.0 ) {

															gsRay.maxDist = max( gsRay.maxDist - gsHit.dist, 1e-4 );

														}

													}

													if ( gsBlocked ) {

														gsT = vec3f( 0.0 );

													}

													if ( gsPass == 0u ) {

														gsT0 = gsT;
														gsOpaque = gsBlocked;
														gsGlass = gsDist >= 0.0 && ! gsBlocked;
														if ( gsGlass && dot( gsDev, gsDev ) > 1e-10 ) {

															gsPasses = 2u;

														}

													} else {

														gsT1 = gsT;

													}

												}

												if ( gsOpaque ) {

													gsShadow = vec3f( 0.0 );

												} else if ( gsPasses == 2u ) {

													// spectral: the sharp shadow plus the difference this wavelength sees (zero where nothing
													// changes → no colour noise on plain glass shadows), fading with the distance behind the
													// glass. Its colour weight has a mean of 1 – only the colour part (weight − 1, mean 0) is
													// amplified (× 3, the spread bands are narrow), the brightness stays the plain average. A
													// wavelength already chosen by a dispersive surface carries its colour in the throughput.
													let gsColor = select( ${ dispersionColorWeightFunc }( gsLambda ), vec3f( 1.0 ), dispersionWavelength > 0.0 );
													let gsFade = exp( - gsDist / max( ${ __GS.falloff }, 1e-6 ) );
													gsShadow = max( gsT0 + ( gsT1 - gsT0 ) * ( 1.0 + 3.0 * ( gsColor - 1.0 ) ) * gsFade, vec3f( 0.0 ) );

												} else {

													gsShadow = gsT0;

												}

											}
