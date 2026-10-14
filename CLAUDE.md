# RINDR

## Grundsätzliches ZIELE
Ein performater 3D Viewer im Browser der Qualitativ mit Keyshot oder Vray mithalten kann.
### Anzeigemodus:
[X] Beim Drehen ist die Anzeige in einem Preview-Modus und sobald die Kamera stillsteht geht der Pathtracing Modus los

### SCENE GRAPH 
[X] In einer Scene können verschiedene Objekte enthalten sein, diese werden alle im SCENE GRAPH dargestellt
[X] im Scene Graph sind auch Lichter, HDRI und KAMERA enthalten
[X] Jedes Objekt im Scene Graph kann ausgewählt, ein- und ausgeblendet werden
[X] bei Mouse-Over im SCENE GRAPH wird das jeweilige Objekt mit einer Outline hervorgehoben

### MATERIAL-EDITOR
[X] Es gibt einen Materialeditor in dem Materialien angelegt oder aus einem Material-Pool geladen werden können
[X] Beim STEP-Import werden Farben aus dem STEP-Model erkannt und als Dummy-Materialien angezeigt die durch Materialien aus einer Material-Bibliothek ersetzt werden können. Jedes Material hat eine eigene ID und lässt sich per Drag & Drop auf ein Modell ziehen (entweder direkt oder im Objekt-Baum)
[X] Ist ein Objekt ausgewählt wird auch im Material-Editor sichtbar welches Material dem Objekt zugewiesen wurde

### MATERIALIEN und MATERIAL EDITOR
[X] Für Materialien verwenden wir three.js TSL
[X] Man sieht alle in der Szene verwendeten MAterialien und kann diese bearbeiten
[X] Die Bearbeitung der einzlenen Materialien basiert per NODES. 
[X] Materialien lassen sich exportieren oder importieren (JSON)

### OBJEKTE MANIPULIEREN
[X] Jedes Objekt in der Szene lässt sich verschieben (XYZ) und drehen (XYZ)

## Projektregeln

- Antworten an den Nutzer auf Deutsch; Code (Bezeichner, Kommentare, Konsolen-Ausgaben) komplett englisch.
- Konsole still (Wunsch des Nutzers): Info-Ausgaben nur über `debugLog()` aus `src/scripts/log.js` – erscheinen nur mit `?debug`; kein `console.log/info` direkt (Ausnahmen: `debug-stats.js`, `benchmark.js`, laufen nur mit `?debug`/`?bench`). `console.warn/error` bleiben.
- Oberflächentexte nur über `src/i18n/de_de.json` + `en_us.json` (`t()` aus `i18n.js`), neue Schlüssel immer in beiden Dateien – Details: `docs/i18n.md`.
- Neues Dateiformat = in allen Format-Texten nennen (Wunsch des Nutzers): `status.dropFormats` (Start-Hinweis), `page.drop.hint` (Drop-Fläche), `about.description` – de_de + en_us; neue Bibliotheken in `src/scripts/libraries.js` eintragen (+ `about.libs.<id>` in beiden Sprachdateien) – daraus entstehen „Über“ in der App und „Built with“ in der README (`scripts/sync-readme.mjs`, läuft automatisch vor jedem `npm run build`; README danach mit committen).
- Große Modelle in `public/models/` und HDRIs in `public/hdr/` nicht committen (beide in .gitignore).
- **Dokumentation:** Diese Datei ist Übersicht, Regeln und Ziele. Die Details stehen in `docs/` (Karte unten). Vor Arbeit an einem Bereich die passende Datei lesen; nach Änderungen dort nachtragen (Verhalten, Entscheidungen des Nutzers, verworfene Wege, Fallstricke, Prüfskripte) – hier nur, wenn es übergreifend ist.

## Karte der Detail-Dokumentation

| Datei | Inhalt |
|---|---|
| `docs/i18n.md` | Sprache / i18n – Oberflächentexte, Sprachdateien, Prüfskript. |
| `docs/step-import.md` | STEP-Import – Eigener STEP-Kernel (`src/scripts/rindr.js`, `step/`, `step-importer.js`, `instancer.js`, `shape-match.js`): Struktur, Tessellierung, Orientierung, Hochachse, Speicher, Qualität, Instancing. |
| `docs/mesh-import.md` | Mesh-Import (glTF, FBX, STL, PLY) – `src/scripts/mesh-importer.js`, `mesh-orient.js`. |
| `docs/bim.md` | IFC / BIM und BCF – `src/scripts/ifc/`, `src/scripts/bcf/`. |
| `docs/splats.md` | Gaussian Splats – `src/scripts/splat/`. |
| `docs/animation.md` | Animation und Morph Targets – `src/scripts/animation.js`. |
| `docs/rendering.md` | Raster-Darstellung – Darstellungsarten, Batcher (`render-batcher.js`), Schatten, Einblenden, Hervorhebung, Schnittebene, eigene Render-Durchgänge. |
| `docs/pathtracer.md` | Pathtracer (HQ) – `src/scripts/pathtracer.js` (three-gpu-pathtracer WebGPU, Vite-Patches in astro.config.mjs). |
| `docs/camera-lens.md` | Kamera, Tiefenschärfe, Fisheye, Objektiv-Effekte – `dof.js`, `fisheye.js`, `lens-effects.js`, `volume-shafts.js`, Kamera-Teile von `viewer.js`/`properties.js`. |
| `docs/environment.md` | Umgebung, HDRI, Boden – `environment.js`, `ground.js`, `background-dome.js`, `contact-shadow.js`, `shadow-catcher.js`. |
| `docs/materials.md` | Materialien und Node-Editor – `material-*.js`, `graph-apply.js`, `node-editor.js`. |
| `docs/scene-state.md` | Szenen-Zustand, Speichern/Laden, Assets, Rückgängig – `scene-state.js`, `assets.js`, `history.js`, Teile von `viewer.js`. |
| `docs/ui.md` | Oberfläche und Bedienung – Scene Graph, Eigenschaften/Gizmo, Leiste, Drop-Fläche, mehrere Modelle, Menüs, Dialoge, Tasten, Auswahl. |
| `docs/export-ki.md` | Bild-Export und KI-Rendering – `image-export.js`, `png-encode.js`, `ki-render.js`, `ki-gemini.js`. |
| `docs/vision.md` | Zukunftsvisionen (Distributed Rendering) |

## Stand (2026-10-14)

**Bundle (Okt. 2026):** Start-JS ≈ 1,35 MB (Haupt-Skript 380 KB + three.js 690 KB WebGPU/TSL + 280 KB Kern; ~380 KB gzip; vorher 2,08 MB / 587 KB). Erst bei Bedarf: glTF/FBX-Loader (`loadLibs` in mesh-importer.js) und Pathtracer + OIDN + Upscaler (~420 KB, `pathTracing.load()`: dynamischer Import, `requestIdleCallback` nach dem Start lädt vor – Erzeugen ~10 ms, kein Einfrieren; `setScene` wartet notfalls darauf; Einstellungen bis dahin in `_settings`, FSR-Schärfe über `pathTracing.sharpness`). Weitere Hebel: Sprachdateien einzeln laden (~30 KB). `.htaccess` komprimiert auch `text/javascript`, `application/wasm`, SVG. Analyse: Build mit `vite.build.sourcemap` + Bytes je Quelle über source-map-js (Scratchpad `sizes.cjs`).

**Stack:** Astro 7 + Tailwind 4, npm (`npm run build` → `dist/`, DDEV-Docroot `dist`). Unterverzeichnis auf dem Server: `BASE_PATH=/rindr/ npm run build` (absolute Social-Preview-Links: `SITE_URL` in `.env`, siehe `.env.example`; astro.config liest `.env` per `loadEnv`) (`base` in astro.config.mjs; Laufzeitpfade über `import.meta.env.BASE_URL` bzw. relativ; URL mit Schrägstrich am Ende aufrufen). Kein Server-Code mehr – reine statische Seite (KI läuft im Browser). **Deployment:** GitHub Pages https://msd8g.github.io/rindr/ – `.github/workflows/static.yml` baut bei Push auf `master` (`npm ci` + `npm run build`, `BASE_PATH`/`SITE_URL` aus `configure-pages`, Repo-Variable `SITE_URL` hat Vorrang) und veröffentlicht `dist/`; in den Pages-Einstellungen muss die Quelle „GitHub Actions“ sein. Pfade im HTML über `base` (auch Icons/Manifest; Manifest-Icons relativ). GitHub Pages setzt kein COOP/COEP → `public/coi-serviceworker.js` (coi-serviceworker 0.1.7, unverändert, als erstes Skript im `<head>` von index.astro) setzt die Header per Service Worker: einmal Neuladen beim ersten Besuch, danach isoliert; ist die Seite schon isoliert (eigener Server mit `.htaccess`, `npm run dev`), registriert er sich nicht. Meldungen nur mit `?debug` (`public/coi-config.js` – Datei statt Inline-Skript wegen CSP). **Sicherheits-Header:** Content-Security-Policy als `<meta>` in index.astro (nur im Produktions-Build – der Dev-Server braucht HMR/Inline-Skripte; kein Inline-Skript, `'wasm-unsafe-eval'` für WebAssembly, `worker-src blob:` für Draco/KTX2, `connect-src` erlaubt nur die KI-Adresse aus `KI.endpoint` – neue externe Dienste dort eintragen) + Referrer-Policy als `<meta>`; nur als Header möglich (frame-ancestors, X-Frame-Options, X-Content-Type-Options, Permissions-Policy, HSTS): eigener Server `public/.htaccess`, GitHub Pages über den Service Worker (in `coi-serviceworker.js` ergänzt, `SECURITY_HEADERS` – mit .htaccess synchron halten; erst ab dem zweiten Laden, HSTS sendet GitHub selbst). Permissions-Policy nur mit Merkmalen, die Chrome kennt (`bluetooth` erzeugte eine Konsolen-Warnung). Geprüft headless: alle Formate + HQ ohne CSP-Verletzung, Header im Dokument (GitHub-ähnlich über Service Worker, eigener Server direkt). Ohne Isolation (z.B. Privatmodus ohne Service Worker) greifen die Ausweichwege: STEP-Worker mit Kopien (Anzahl nach Dateigröße), Splats ohne geteilten Speicher. Geprüft headless: Server ohne Header → 2 Navigationen, isoliert, große STEP-Baugruppe mit 12 Workern + SharedArrayBuffer; Server mit Headern → kein Service Worker. three ^0.186 (WebGPU), three-mesh-bvh, three-gpu-pathtracer 0.0.26 (WebGPU), oidn-web, @pmndrs/upscaler ^0.2 (gepinnt), earcut (lil-gui steht noch in package.json, wird nicht mehr benutzt).

**Zentrale Dateien**
- `src/scripts/viewer.js` – Szene, WebGPURenderer (fordert Adapter-Maximum für Puffergrößen an), GUI, Render-Loop, Statusanzeige. Start mit leerer Szene; Datei per Drag & Drop ins Fenster öffnen (auch mehrere Dateien/Ordner: Hauptdatei STEP > GLB/glTF > FBX/STL > PLY/SOG, Rest = Texturen/.bin; Gaussian Splats siehe unten). `loadModel()` ist gemeinsam für alle Formate, `runLoad()` serialisiert Laden/Neu-Tessellieren. Neues Modell während eines Imports (`openModel`): laufender Import wird abgebrochen (`loadAbort` = AbortController fürs Dateilesen/fetch, `abortStepImport()` beendet den Worker-Pool, offene Worker-Anfragen enden mit AbortError → `loadModel` räumt still auf). `model` wird erst in `runLoad` übernommen (`nextModel`), nie während ein Ladevorgang läuft – vorher las der alte Import ab dem Ablegen die Daten des neuen Modells. `?debug` → `globalThis.__viewer` (u.a. `openModel`, `isLoading`), außerdem Debug-Anzeige rechts unten (`debug-stats.js`: fps + CPU-ms/Bild, GPU belegt laut `renderer.info.memory` – Gesamt-VRAM gibt WebGPU nicht heraus –, JS-Heap/Seite inkl. Worker/`deviceMemory`, Modell-Dreiecke gesamt/sichtbar/eindeutig, Dreiecke + Draw-Calls des letzten Bilds), `?model=<datei>` lädt `public/models/<datei>` (auch .glb/.fbx). Startet weder WebGPU noch WebGL2, zeigt die Statuszeile `status.noRenderer` statt einer leeren Seite (geprüft headless mit `--disable-webgl` + ohne `navigator.gpu`).
- `src/scripts/config.js` – zentrale Voreinstellungen (`PATHTRACING`: Bounces, Max. Samples, Auflösung, Glossy-Filter, Denoise, FSR, Megakernel, frameBudget); `MATERIALS.editing` = false blendet die Material-Bearbeitung aus: Parameter, Node-Editor, Umbenennen, „+ Neu“, „Kopie“. Liste, Bibliothek, Drag & Drop, Zuweisen und Löschen bleiben; `MATERIALS.importExport` = false blendet Import/Export (JSON) aus (kommt später); vorhandene Graphen wirken weiter. Kommt später separat wieder. Hier anpassen statt in `pathtracer.js`. `IMPORT` (Speicherschutz STEP): `triangleBudget` 10 Mio., `triangleLimit` 30 Mio. (eindeutige Dreiecke).

**Übergreifende Fallstricke**
- three.js r186-Bug (#34608, Fix erst r187): `FramebufferTexture.clone()` teilt das Bild mit dem Original → OIDN-Hilfspuffer (kleinere Auflösung) „schrumpfte“ die Transmission-Textur des Canvas → Neuanlage im offenen Render-Pass → „Destroyed texture used in a submit“ bei Glas. Workaround ganz oben in `viewer.js` (Klone bekommen eigene `TextureSource`). Beim Update auf r187 prüfen/entfernen.
- three.js r186 `Renderer._getShadowNodes`: Wird `material.map` entfernt, behält das gemeinsame Schatten-Material den alten Farb-Node (`if (colorNode !== null)`) → Schatten-Pass liest `null.matrix`, Render-Schleife bricht ab (Viewport nicht mehr drehbar). Workaround in `graph-apply.js` (`setMap`): Farb-Map statt `null` eine weiße 1×1-Textur. Beim three-Update prüfen.
- Speicher-Leck (behoben): three.js (WebGPU) hält Render-Objekte in `renderer._objects._renderObjects` (Set), bis am Mesh selbst `dispatchEvent({ type: 'dispose' })` kommt – `geometry.dispose()` reicht nicht. `disposeRoot` macht das; vorher blieb bei jedem Neu-Tessellieren/Modellwechsel das ganze alte Modell im Speicher (Hunderte MB je Durchgang bei großen Modellen). Beim Entfernen von Meshes immer so freigeben.

**Tests**
- Browser: Headless-Chrome mit WebGPU über SwiftShader (puppeteer im Scratchpad, fehlende Libs per `apt-get download` + `dpkg -x`, `LD_LIBRARY_PATH`; Flags `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --use-angle=swiftshader --no-sandbox`). lil-gui `setValue()` löst kein `onFinishChange` aus.
- Headless-Test: Screenshot bei eingeschalteter Bodenprojektion (Software-GPU, ~4 fps) → „Target closed“ – Testumgebung, nicht die App (kleineres Fenster oder Status statt Bild prüfen).
- Logik ohne Browser: Node-Skripte im Scratchpad (Beispiele in den docs-Dateien).

## Offen
- **Geplant (Nutzer, Okt. 2026):**
  - HDRI per Drag & Drop: `.hdr`/`.exr` ins Fenster ziehen → wird geladen und sofort als Umgebung gewählt (heute nur `public/hdr/` per Build-Liste bzw. `?hdr=`; Laden über `environment.selectFile` gibt es schon – beim Relink genutzt). Drop-Logik: HDRI-Datei allein = Umgebung, kein Modell-Ersetzen/Hinzufügen; Szenen-Zustand/Asset-Fenster müssen die Datei als Asset führen. Format-Texte ergänzen.
  - Texturen auf Flächen ziehen (Decals/Aufkleber): Bilddatei auf ein Objekt im 3D-Fenster ziehen → als Decal an der Trefferstelle projiziert (Position/Größe/Drehung danach einstellbar), Raster + Pathtracer; offene Fragen: eigene Decal-Geometrie (DecalGeometry) vs. Textur-Projektion im Material, Verhalten auf gekrümmten Flächen, Speichern im Szenen-Zustand (Bild als Asset). Heute löst ein Bild-Drag nur „Fehlende Dateien verknüpfen“ aus (`isAssetDrag`) – Abgrenzung nötig.
- Import-Materialien: Texturen gehen beim JSON-Export verloren (Graph verweist nur auf den Map-Schlüssel); Mischen von Materialien per Maske (KeyShot-Stil) geplant; Vertex-Farben, Lichter/Kameras aus glTF/FBX werden ignoriert; FBX-Phong → Rauheit aus Shininess geschätzt. glTF/FBX nur mit selbst erzeugten Testdateien geprüft (Scratchpad `gen.py`).
- Node-Editor: kein Zoom; Box-UVs haben Nähte auf gekrümmten Flächen; importierte Materialien landen in der Szene, nicht dauerhaft in der Bibliothek.
- Ungenutzte STEP-Dummy-Materialien werden beim Neu-Tessellieren entfernt.
- Sehr große STEP-Dateien (~400 MB, ~6 Mio. Dreiecke) laden im Headless-Chrome in ~30 s; Dateien ≥ 1 GB kaum getestet. Weitere Hebel: Worker-Zahl an Dateigröße koppeln, Tangenten nur bei Normal-Maps, CPU-Kopien nach GPU-Upload freigeben.
- Nicht unterstützt: Nähte in u *und* v, OFFSET_CURVE, COMPOSITE_CURVE; Längeneinheit ignoriert.
- Echte GPU / echter Browser nur vom Nutzer getestet.

## Umgesetzte Wünsche

### Neue Objektmodification:
[X] Skalierung, analog zu verschieben/drehen

### QUAD-Menü
[X] wenn man ein OBjekt ausgewählt hat soll sich bei der rechten maustaste ein Quad-Menü öffnen wie bei MAX. Erstmal nur mit zwei Panels
[X] Quadmenü Panel 1: Alles einblenden, Nicht ausgewählte Objekte ausbleden, Auswahl ausblenden
[X] Quadmenü Panel 2: Verschieben, Drehen, Skalieren

### EXPLODE
[X] wir brauchen ein Toggle um das Objekt explodieren zu lassen damit man schnelle eine Explosionsdarstellung visualisieren kann. Im Idealfall fliegen die einzelnen Objekte dann smooth auseinander und wieder zusammen.

### KI RENDERING
[X] Neben dem HQ-Button soll noch ein KI-Button rein der das aktuelle HQ-Bild an eine Bildgenerierung-KI schickt.
[X] Der große Vorteil ist dass wir nicht nur das aktuelle Bild an die KI senden können sondern im Prompt gleich alle verwendeten Materialien beschreiben können, wir geben also direkt unsere Materialnamen mit statt nur der Farbinformation
[X] Wir brauchen also noch eine API die (openapi) die den vermittler zwischen unserem Viewer und dem externen KI Anbieter macht. So kann auch keiner die KI-API Informationen bekommen und wir können zwischenspeichern was wir an die KI senden
