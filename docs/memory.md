# Speicher und Gerätegrenzen

Große Modelle passen sich dem Rechner an, statt den Tab abstürzen zu lassen. Grundsatz (Nutzer, Okt. 2026): **universell, nicht auf den Entwicklungsrechner abgestimmt** – Grenzen kommen aus dem, was der Browser über das Gerät meldet; reicht die Hardware nicht oder fehlt ein Feature, gibt es einen Hinweis im Stil der Panels.

## Warum Tabs abstürzen

| Speicherart | Grenze | Überschreiten |
|---|---|---|
| JS-Heap (Objekte, normale Arrays, Strings) | Chrome: alle JS-Heaps eines Tabs (Haupt-Thread + Worker) teilen sich **4 GB** – unabhängig vom RAM | Absturz, in JS nicht abfangbar |
| ArrayBuffer / SharedArrayBuffer / WASM | RAM und Prozessgrenzen | `RangeError` bzw. das System beendet den Tab |
| GPU | VRAM (nicht abfragbar) | `GPUOutOfMemoryError` / device lost – Tab bleibt (Pathtracing aus) |

Gemessen (RTX 3080, Windows-Chrome, Renderer-Prozess per CDP-Prozess-ID + `tasklist`, Scratchpad `procmem.js`/`mem2.js`):
- Großes binäres FBX (668 MB, 23 Mio. Dreiecke): three.js' FBXLoader parst synchron im Haupt-Thread (Seite reagiert ab ~8 s nicht mehr) und baut je Polygon-Ecke normale JS-Arrays → 4,6 GB nach 26 s, Tab weg. **Auf jedem Rechner**, da 4-GB-Grenze.
- Große STEP-Baugruppe (929 MB, ein Körper mit 79 000 Flächen): lud, aber bis **7,3 GB** – der Sprung kam beim Tessellieren (16 Worker mit je eigenem Heap), danach 4,7 GB. Auf Rechnern mit weniger RAM / vielen Tabs = Absturz.

## Budget (`src/scripts/memory-budget.js`)

- `deviceMemoryGB()`: `navigator.deviceMemory` (gerundet; ältere Chrome deckelten bei 8, aktuelle melden z.B. 32; Firefox/Safari: fehlt → 4 angenommen). Test: `?deviceMemory=2`.
- `memoryBudget()` = halber gemeldeter RAM, 0,75–6 GB (Rest: System, Browser, andere Tabs); im sparsamen Modus die Hälfte.
- `triangleLimits(IMPORT)`: Dreiecksbudget/-grenze für das Öffnen = Budget ÷ `BYTES_PER_TRIANGLE` (260 B: Geometrie, BVH, Tangenten, Kopie des Pathtracers) – die Werte in config.js sind die Obergrenze, kleinere Geräte skalieren herunter (viewer.js `importLimits()`, `?debug&triangleBudget=…` übersteuert weiterhin). Beispiele: 32 GB → Grenze 24,7 Mio., 8 GB → 16,5 Mio., 2 GB → 4,1 Mio.
- `workersWithin(proWorker, reserviert, max)`: Worker-Zahl nach Budget statt nur nach Kernen.
- `MemoryGate`: Aufträge starten erst, wenn ihr geschätzter Bedarf zusammen mit den laufenden ins Limit passt (mindestens einer läuft immer).

## Wo es greift

- **STEP-Worker-Pool** (`poolSize` in step-importer.js): je Worker 450 MB (gemessen: +370 MB Spitze je Worker beim Tessellieren), reserviert 30 % des Budgets für die Ergebnisse im Haupt-Thread + die Datei (SharedArrayBuffer); ohne Isolation zusätzlich je Worker eine Kopie der Datei (ersetzt das alte feste `COPY_BUDGET`). `?workers=N` übersteuert. Große Baugruppe: 16 → 7 Worker, Spitze 7,3 → **4,9 GB**, Ladezeit gleich (~54 s); zum Vergleich 4 Worker: 4,2 GB, 61 s.
- **BVH-Aufbau** (`buildBVH`, auch beim Mesh-Import): `MemoryGate` mit 30 % des Budgets, Bedarf je Auftrag ≈ 70 B/Dreieck + 40 B/Eckpunkt. Wird beim Beenden des Pools zurückgesetzt (abgebrochene Aufträge geben nie frei).
- **FBX**: eigener schlanker Leser (mesh-import.md) – JS-Heap 9 MB statt > 4 GB. Großes FBX: Spitze 5,6 GB (Budget 6 GB) bzw. 4,4 GB mit `?deviceMemory=8`.
- **Mesh-Formate ohne Tessellierungsstufen** (glTF/FBX/STL/PLY): nach dem Lesen ist die Dreieckszahl bekannt – über der Grenze fragt `confirmLargeModel` (viewer.js, Option `checkSize` von `importMeshFile`) vor BVH und GPU-Upload: Dialog „Sehr großes Modell“ mit Dreiecken, geschätztem Bedarf, Arbeitsspeicher des Geräts; „Abbrechen“ ist vorausgewählt.
- **Sehr große Dateien** (abgelegte Datei > halbes Budget): `confirmLargeFile` fragt schon vor dem Einlesen (nur beim Öffnen, nicht beim Neu-Tessellieren). `?model=`-Dateien: Größe erst nach dem Laden bekannt → nur die Dreiecksprüfung.
- STEP ohne Ausweg (auch „Grob“ über der Grenze): Hinweis „Modell zu groß für dieses Gerät“ (`showLimitError` → Hinweis-Karte statt Statuszeile), automatisch gesenkte Qualität ebenfalls als Hinweis.

## Absturz erkennen (`src/scripts/load-guard.js`)

- Während eines Ladevorgangs (viewer.js `guardedLoad` um `loadModel`/`loadExtraModel` in `runLoad`) steht `rindr.loading` in sessionStorage; entfernt beim Ende des Ladens und bei `pagehide` (Neuladen, Schließen = kein Absturz).
- Beim Start noch da → Hinweis „Letzter Ladevorgang abgebrochen“ (+ Arbeitsspeicher des Geräts), Modell bekommt `rindr.safeLoad`. Ein `?model=`-Modell wird dann **nicht** automatisch erneut geöffnet (Absturzschleife), der Hinweis bietet „Sparsam öffnen“; abgelegte Dateien: „Lege die Datei erneut ab“.
- Sparsamer Modus beim nächsten Öffnen derselben Datei (Name + Größe): halbes Budget (weniger Worker, kleinere Schranke, kleinere Dreiecksgrenzen), STEP startet mit der gröbsten Stufe, Hinweis „Sparsamer Modus“; danach wieder normal.
- Geprüft (Scratchpad `crashsim.js`): Merker gesetzt + Neuladen → Hinweis, kein automatisches Öffnen, „Sparsam öffnen“ → Qualität „Grob“, danach beide Merker leer.

## Hinweise und Dialoge

- `src/scripts/notice.js` `showNotice({ id, icon, title, message, actions, timeout })`: Karten oben mittig, Panel-Stil (`bg-black/60`, Blur), Symbol (Warnung amber / Info sky), Knöpfe, ✕; gleiche `id` ersetzt.
- `dialog.js` `choiceDialog({ title, message, icon, facts, buttons })`: mehrere Antworten, Warn-/Info-Symbol im Kopf, Faktenblock (Beschriftung/Wert), Esc/Klick daneben = Knopf mit `cancel`.
- Weitere Hinweise: „HQ nicht verfügbar“ (kein WebGPU, beim Wählen von HQ), „Ohne Animation geladen“ (großes animiertes FBX über den schlanken Leser).
- Texte: `memory.*`, `feature.*` in beiden Sprachdateien.

## Offen

- Spitze beim großen FBX liegt nach dem BVH-Aufbau (GPU-Upload: three.js behält CPU-Kopien der Attribute) – weiterer Hebel: CPU-Kopien nach dem Upload freigeben.
- Freien Speicher meldet kein Browser; `performance.measureUserAgentSpecificMemory()` (mit Isolation) ist zu langsam zum Steuern, nur zur Anzeige (debug-stats.js).
