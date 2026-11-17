# Pokémon-Collector

Web-App (PWA) zur Verwaltung einer Pokémon-Sammlung: Einzelkarten (auch gegradet) und versiegelte Produkte, Einkaufspreise je Exemplar, Zustand, eigene Fotos, Marktwert von Cardmarket.

- Adresse: https://stephanweigelt-ger.github.io/pokemon-collector/
- Läuft auf iPhone, iPad und PC; über „Zum Home-Bildschirm“ als App installierbar.
- Daten liegen auf dem Gerät (IndexedDB) und werden über Dropbox (App-Ordner, Unterordner `pokemon/`) zwischen Geräten abgeglichen. Anmeldung per Code, keine Weiterleitungs-Adresse nötig.
- `data/katalog.json`: alle Sets und Karten von TCGdex (Deutsch/Englisch).
- `data/produkte.json`: versiegelte Produkte mit Cardmarket-Preisen und Produktbildern (TCGplayer über tcgcsv.com).
- Beide Dateien baut der Ablauf `.github/workflows/katalog.yml` jeden Montag um 00:01 Uhr (deutsche Winterzeit) neu. Es werden keine Geheimnisse (Secrets) benötigt.
- In der App selbst werden Marktwerte beim ersten Öffnen nach Montag 00:01 Uhr (Europe/Berlin) aktualisiert.
