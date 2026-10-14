# Zukunftsvisionen

## Distributed Rendering (Rendern auf mehreren Rechnern)
Nur für finale Standbilder (hohe Auflösung/viele Samples) und Animationen sinnvoll – nicht für die interaktive Ansicht (jede Kamerabewegung = Neustart auf allen Knoten, Netzwerk-Latenz frisst den Gewinn). Grundlage ist der Szenen-Zustand (`scene-state.js`): Modelldatei + Zustand-JSON + HDRI legen ein Bild eindeutig fest.

**Standbild: Samples aufteilen statt Kacheln**
- Jeder Knoten rendert das *ganze* Bild mit eigenem Zufalls-Seed, Koordinator mittelt gewichtet nach Sample-Zahl (4 Knoten × 64 Samples ≈ 256 Samples in ¼ der Zeit).
- Vorteile gegenüber Kacheln: kein Lastungleichgewicht (Glas/dunkle Ecken teurer als Himmel), unterschiedlich schnelle GPUs mischbar, Ausfall eines Knotens kostet nur Samples, Bild wird progressiv besser, keine Nähte – OIDN einmal am Ende auf dem gemittelten Bild.
- Netzwerk: ein Float-Bild je Knoten und Runde (Full HD ~16–32 MB) + einmal Albedo/Normalen für den Denoiser.

**Animation: Frames aufteilen**
- Noch einfacher: jeder Knoten rendert ganze Frames (Frame-Splitting), Koordinator verteilt Frame-Nummern und sammelt die fertigen (entrauschten) Bilder ein → Video/Bildfolge.
- Dafür bräuchte es eine Animationsbeschreibung im Szenen-Zustand (Kamerapfad, Bauteil-Bewegungen als Keyframes). Eine Kamerafahrt durch die gespeicherten Ansichten + Drehteller in der Abspielleiste wurde gebaut (Okt. 2026) und auf Wunsch des Nutzers wieder entfernt (Kamera-Auswahl erschien bei jedem animierten FBX und verwirrte).

**Bausteine**
1. Render-Knoten: Viewer ohne Oberfläche (z.B. `?node`) – lädt Modell + Zustand + HDRI, rendert mit eigenem Seed bzw. zugeteilte Frames, schickt das Ergebnis zurück. Beliebiger Browser mit WebGPU oder Headless-Chrome auf einem GPU-Server.
2. Koordinator: kleiner Server (z.B. Node + WebSocket) – verteilt Aufträge, sammelt/mittelt, entrauscht, liefert aus. Der eigene Browser kann mitrendern.
3. Pathtracer: Seed je Knoten (`stableNoise = true` ist Voreinstellung → alle Knoten würden identische Samples liefern, prüfen/umbauen); Readback des aufsummierten Float-Bilds aus dem Render-Target (nicht des tonemappten Canvas).
4. Gleiche Geometrie überall: identische Tessellierung (gleiche Qualitätsstufe, STEP-Kernel deterministisch? – prüfen).

**Grenzen / offene Fragen**
- Jeder Knoten braucht das ganze Modell im GPU-Speicher – hilft nicht bei Modellen, die für eine GPU zu groß sind.
- Große STEP-Dateien müssen zu jedem Knoten → zentral ablegen statt per Browser hochladen.
- Vorgehen: erst Prototyp im lokalen Netz (2 Tabs/Rechner, Node-Koordinator, Knopf „Verteilt rendern“), dabei zuerst Seed/Readback klären; danach Robustheit (Knoten-Ausfall, Fortschritt) und Modell-Ablage.
