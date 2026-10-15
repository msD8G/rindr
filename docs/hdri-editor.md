# HDRI-Editor

Eigene, prozedural erzeugte HDRIs (wie KeyShots HDRI-Editor): entweder ein fertiges HDRI laden (wie bisher, `public/hdr/` bzw. Relink) oder den Editor starten und eigene Varianten anlegen – Startpunkt ist das bisherige Studio-HDRI als Vorlage. Auftrag des Nutzers Okt. 2026.

## Aufgabe (Checkliste)

- [x] Export des HDRI (`.hdr` Radiance, `.exr` OpenEXR; Auflösung wählbar)
- [x] Hintergrundverlauf (Farbe oder Verlauf mit Stopps über die Höhe)
- [x] Verschiebbare, interaktive Sonne & Himmel (Himmelsmodell, Sonne auf der Arbeitsfläche ziehen)
- [x] Bodenfarbe für Sonne & Himmel
- [x] Parameter für Sonnengröße
- [x] Abgerundete Ecken für rechteckige Pins (Pins = Licht-Marker, verschieb- und editierbar)
- [x] Verlaufs-Pins (mit Verlaufs-Editor: Leiste + ziehbare Stopps, `gradient-editor.js`; auch für den Hintergrundverlauf)
- [–] ~~Farbanpassungen für Bild-Pins~~ – entfallen: keine Bild-Pins (Entscheidung des Nutzers, Okt. 2026; kurz umgesetzt, wieder entfernt – alte Szenen: Bild-Pin → Farb-Pin in `normalizeHdri`)
- [x] HDRI-Editor-Arbeitsfläche abdocken

## Aufbau

- `src/scripts/hdri/hdri-model.js` – Beschreibung eines eigenen HDRI (JSON, Versionsnummer), Vorgaben, Vorlage „Studio“ (Nachbau von `createStudioEnvironment`), neue Pins je Typ, Kopieren/Prüfen beim Laden.
- `src/scripts/hdri/hdri-render.js` – Generator ohne DOM/three (läuft im Worker): Beschreibung → lineares RGBA (Float32) in Equirect-Anordnung von three.js (`equirectUV`: u = atan2(z, x)/2π + 0,5, v = asin(y)/π + 0,5; Zeile 0 = unten wie `hdr-worker.js`). Hintergrund (Farbe/Verlauf/Sonne & Himmel), dann Pins in Reihenfolge.
- `src/scripts/hdri/hdri-worker.js` – rechnet im Worker, liefert Half-Float für die Textur + 8-Bit-Vorschau (tonemapped) für die Arbeitsfläche.
- `src/scripts/hdri/gradient-editor.js` – Verlaufs-Editor (Pins mit Verlauf, Hintergrundverlauf): Leiste mit dem Verlauf, darunter Stopp-Marker; Klick in die Leiste = neuer Stopp (Farbe aus dem Verlauf an der Stelle), Marker ziehen = verschieben, Doppelklick auf einen Marker = Farbwähler (`openColorPicker` aus ui-controls.js, am Marker), weit nach oben/unten ziehen = entfernen (mind. 2 bleiben). Doppelklick selbst erkannt (Marker werden bei der Auswahl neu gezeichnet → natives `dblclick` unzuverlässig). Keine Zeile mit Farbe/Position darunter mehr (Wunsch des Nutzers). Marker rund, mit Ring 16 px wie die Regler-Griffe (12 px + 2 px Ring außen; Wunsch des Nutzers), gewählter mit blauem Ring. Hintergrund: Position = Höhe −90° (links, unten) … +90° (rechts, oben).
- `src/scripts/hdri/hdri-export.js` – `.hdr` (RGBE, Zeilen oben → unten) und `.exr` (three.js `EXRExporter` mit `DataTexture`).
- `src/scripts/hdri/hdri-editor.js` – Fenster: Arbeitsfläche (Equirect 2:1, Pins als SVG-Umrisse + Griffe, Sonne als Griff), Seitenleiste (Hintergrund, Sonne & Himmel, Pin-Liste, Eigenschaften des gewählten Pins), Kopf (Name, Auflösung, Export, Duplizieren/Löschen, Schließen).
- Einbindung: `environment` in viewer.js kennt eigene HDRIs (`environment.custom`: id → Beschreibung, `env.hdri = 'editor:<id>'`), Umgebungs-Panel: Auswahl listet sie unter „Eigene“, Knöpfe „Neu“/„Bearbeiten“. Szenen-Zustand `environment.custom`. KI-Prompt/Asset-Fenster behandeln `editor:`-Namen als eigenes HDRI (keine Datei).

## Modell

```
{ version: 1, id, name,
  background: { mode: 'color' | 'gradient' | 'sky', color, brightness,
                gradient: [{ pos: −90…90 (Höhe in °), color }] },
  sky: { azimuth, elevation, sunSize (°), sunIntensity, skyIntensity, turbidity, groundColor, groundIntensity },
  pins: [{ id, name, enabled, shape: 'circle' | 'rect', fill: 'color' | 'gradient',
           azimuth, elevation, width, height (° auf der Kugel), rotation (°), cornerRadius (0–1, Rechteck),
           falloff (0–2, weicher Rand; > 1 = weich bis in die Mitte), color, brightness, blend: 'add' | 'normal',
           gradient: { type: 'linear' | 'radial', stops: [{ pos 0–1, color }] } }] }
```

- Richtung aus Azimut/Höhe wie three.js: (cos h · cos a, sin h, cos h · sin a). Auf der Arbeitsfläche: Azimut −180…180 links → rechts, Höhe +90 oben.
- Pins in lokalen Winkelkoordinaten um ihre Mitte (x = atan2(p·Ost, p·n), y = atan2(p·Nord, p·n), gedreht um `rotation`) → auf der Kugel unverzerrt, auf der Arbeitsfläche zum Pol hin gestreckt (wie bei KeyShot). Rechteck als abgerundete Box (SDF, Radius = `cornerRadius` · halbe kürzere Seite), Kreis/Ellipse über den normierten Radius; `falloff` = Anteil des weichen Rands nach innen.
- Füllung Verlauf: linear entlang der lokalen x-Achse (Drehung dreht ihn mit) oder radial von der Mitte. Keine Bild-Pins (Nutzer: Kreis, Rechteck, Verlauf reichen).
- `blend: 'add'` addiert Licht (Standard, Softboxen), `'normal'` deckt ab (z.B. dunkle Flächen, Abschatter).
- Sonne & Himmel: Himmel nach three.js `Sky` (Preetham/Hoffman: Rayleigh + Mie, Trübung), linear, normiert auf einen Referenzhimmel (Mittag, Trübung 2) → `skyIntensity` 1 ≈ gewohnte Helligkeit, Abendhimmel dunkler; Sonnenscheibe mit Radius `sunSize/2`, Farbe aus der Extinktion entlang der Sonnenrichtung, Strahldichte so, dass die Bestrahlungsstärke unabhängig von der Größe bleibt (größer = weichere Schatten, gleich hell); unter dem Horizont Bodenfarbe × Intensität mit weichem Übergang.

## Bedienung / Verhalten

- Ändern → Neuberechnung im Worker („letzte gewinnt“: läuft eine, wird danach einmal mit dem neuesten Stand gerechnet). Beim Ziehen (Pins, Sonne, Regler) niedrige Auflösung (512 × 256) für Arbeitsfläche + Szene, Pathtracing wie beim Drehen reduziert; beim Loslassen volle Auflösung (Standard 2048 × 1024).
- Rückgängig: ein Schritt je abgeschlossener Änderung (Ziehen = ein Schritt).
- Abdocken: freies Fenster (Titelleiste ziehen, Größe am Rand); Fensterlage im Browser gemerkt (localStorage). Andocken unten gab es zuerst, auf Wunsch entfernt.

## Stand / Entscheidungen (Okt. 2026)

Alle Punkte umgesetzt und geprüft (Windows-Chrome mit echter GPU, siehe CLAUDE.md „Tests“; Skripte im Scratchpad `hdri1/2.js`, `hdri-hq.js`, `hdri-state.js`, `grad.js` (Verlaufs-Editor), Generator-Test in Node `hdri/t.mjs`).

- Einstieg: Umgebungs-Panel → HDRI-Auswahl „+ Neues HDRI…“ (Vorlage Studio, wird sofort die Umgebung und öffnet den Editor) bzw. Stift in der Vorschau bei einem eigenen HDRI; Auswahl listet eigene unter „Eigene (HDRI-Editor)“. Fertige HDRIs laden wie bisher. Editor schließt den Node-Editor (beide unten) und umgekehrt.
- `env.hdri = 'editor:<id>'`, Beschreibungen in `environment.custom` (Map), `environment.useTexture()` tauscht beim Bearbeiten nur die Textur (Name bleibt). `env.select('editor:<id>')` rechnet im Worker (`hdriService.texture`), Importance-Sampling-Tabelle vorher im Worker (env-cdf.js). Szenen-Zustand `environment.custom`; beim Laden wird das gewählte eigene HDRI aus der Beschreibung neu gerechnet, ein offener Editor übernimmt die geladene Fassung (`afterRestore`) oder schließt. Asset-Fenster zeigt es als „Eigenes HDRI (HDRI-Editor, in der Szene gespeichert)“, nicht als fehlende Datei; KI-Prompt nennt seinen Namen.
- Generator-Geschwindigkeit (Node 16, nach Aufwärmen): 512 × 256 ~19 ms (Ziehen), 2048 × 1024 ~330 ms (Studio-Vorlage, im Worker). Pins rechnen nur Zeilen/Spalten ihrer Kugelkappe (`forCap`), Himmel auf ¼-Raster interpoliert. Studio-Vorlage weicht im Mittel ~2 % vom eingebauten Studio ab (Verlauf als 7 Stopps über die Höhe, Softbox-Rand auf Winkel statt Kosinus) – das eingebaute Studio bleibt unverändert.
- Kreis-Pins mit echtem Winkelabstand (exakte Kreise auf der Kugel), Rechtecke in lokalen Winkelkoordinaten (Nähe des Pols gestreckt wie bei KeyShot).
- Boden bei Sonne & Himmel physikalisch: Farbe = Albedo × (Himmel- + Sonnen-Bestrahlungsstärke)/π – vorher feste Helligkeit, viel zu dunkel.
- Arbeitsfläche: Vorschau 1024 × 512 (ACES + sRGB, im Worker), beim Ziehen 512er-Bild hochskaliert; Umrisse/Griffe als SVG darüber (Naht bei ±180° → neuer Teilpfad). Griffe: Mitte = verschieben, Quadrat = Größe (Rechteck: Breite/Höhe aus der lokalen Lage, Kreis/Ellipse: Skalierung), Sonne (gelb) bei Sonne & Himmel. Klick in einen Pin wählt ihn, daneben = abwählen.
- Ziehen/Regler: `onDrag` → Pathtracing wie beim Drehen reduziert (inkl. Kuwahara), Umgebungstextur in 512 px; Loslassen → volle Auflösung + Rückgängig-Schritt (Schnappschuss der Beschreibung als JSON).
- Export: `.hdr` flach (ohne RLE, 2k ≈ 8,4 MB), `.exr` Half-Float ZIP (2k ≈ 0,7 MB); „Speichern unter“ wo verfügbar, sonst Download. Auflösung = Auflösung des HDRI (1k/2k/4k).
- Fenster: immer frei (Wunsch des Nutzers – Andocken unten wieder entfernt): `fixed`, Titelleiste ziehen, Größe per CSS-`resize`, Lage/Größe in `localStorage` (`rindr.hdriEditor.window`), beim ersten Mal mittig; blendet mit „Oberfläche ausblenden“ aus (`data-ui`). Unabhängig vom Node-Editor (beide gleichzeitig möglich).
- Layout (Wunsch des Nutzers): links die Arbeitsfläche, darunter der Hintergrund nebeneinander (Art | Verlauf bzw. Farbe | Helligkeit; Sonne & Himmel: Regler in zwei Spalten – drei waren zu schmal); rechts nur die Pins (Liste, Trennlinie, Einstellungen des gewählten Pins). Standardgröße 1040 × 620.
- Kreis-Pins: Breite und Höhe unabhängig (Ellipsen) – Regler einzeln, Größen-Griff auf dem Ellipsenpunkt (hw, hh)/√2 setzt beide Halbachsen aus der Zeigerlage (lokale Polarkoordinaten), der Griff bleibt unter dem Zeiger (gemessen 0 px). Vorher blieb ein runder Kreis beim Regler rund und der Griff skalierte nur gleichmäßig.
- Entf/Rücktaste löscht den gewählten Pin, solange der Editor der aktive Bereich ist (letzter Klick darin) – sonst behält die Taste ihre Bedeutung im Viewer (Bauteile löschen); in Textfeldern normal.
- Farben: eigener Farbwähler `colorField` (ui-controls.js) statt des nativen Dialogs (Nutzer: passte nicht zum Stil) – Popover im Panel-Stil mit Sättigung/Helligkeit-Fläche, Farbton-Leiste, Hex-Feld; live beim Ziehen, ein Rückgängig-Schritt je Loslassen/Enter/Schließen. Gilt im ganzen Viewer (Lichter, Schnittfläche, Material-Parameter, Node-Editor).
- Eingaben aus `ui-controls.js` wie in den Panels: Zahlenfelder seitlich ziehbar (`draggable`, 300 px = ganzer Bereich; Ziehen = live in 512 px, Loslassen = volle Auflösung + Rückgängig-Schritt), Farbfelder `colorField` (volle Breite; Farbstopps 2,5 rem breit), Auswahlen `SELECT`, Checkboxen `CHECKBOX`.
- Umgebungs-Panel oben (Wünsche des Nutzers): Vorschau des aktuellen HDRI über die volle Panelbreite, ohne Namen daneben (stand in der Auswahl doppelt). Zeigt Intensität × Licht-Boost als Belichtung und die Drehung (Weltazimut a zeigt Texturazimut a + Drehung – geprüft gegen `brightestDirection`: Vorschau und Licht wandern gleich). `drawEnvironmentPreview` in viewer.js: je Textur einmal eine lineare Kopie bis 1024 × 512, per Box-Filter gemittelt (gecacht; zuerst 512er Punktabtastung → Nutzer: „sehr lowres“), je Zeichnen bilinear in Gerätepixeln (HiDPI) + Belichtung + Verschiebung (auch Bruchteile) + ACES/sRGB-Tabelle in einen Canvas (1,2 ms bei 264 px, 4,6 ms bei 528 px – live beim Regler-Ziehen). Tabelle über √(x/64) mit 16384 Einträgen + 4 × 4-Ordered-Dither (auch die Arbeitsfläche im Worker): eine lineare 4096er-Tabelle über 0–64 sprang im Dunklen um mehrere 8-Bit-Stufen → Verläufe stark gestuft (Nutzer); jetzt größter Sprung 1,5/255 im Studio-Verlauf; neu gezeichnet bei jedem `environment.apply()` (`environment.onChange` → `properties.refreshEnvironmentPreview()`). Eigene HDRIs: Stift oben rechts in der Vorschau öffnet den Editor (blau, solange er offen ist); „+ Neues HDRI…“ ist der letzte Eintrag der HDRI-Auswahl (kein eigener Knopf).
- Test-Fallen (Windows-Chrome über CDP; aus der Zeit der Bild-Pins): Datei-Dialog – nach echten Mausaktionen hat die Seite eine Benutzergeste, `input.click()` öffnet den Dialog wirklich; das auslösende `evaluate` kehrt erst nach der Antwort zurück → `waitForFileChooser` vor dem Klick, Klick nicht abwarten, Datei mit Windows-Pfad (`C:\Users\…\Temp`) übergeben (WSL-Pfade kann der Windows-Chrome nicht lesen).
- Offen/Ideen: HDRI per Drag & Drop als Hintergrund-Bild im Editor bearbeiten (KeyShot kann geladene HDRIs mit Pins ergänzen), Pin per Klick aufs Modell setzen („Highlight“-Modus), Vorlagen als Datei speichern/laden, Pin-Reihenfolge per Ziehen.
