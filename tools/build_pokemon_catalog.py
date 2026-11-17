"""Baut data/katalog.json aus der freien TCGdex-API (https://tcgdex.dev).
Aufruf: python3 tools/build_pokemon_catalog.py data/katalog.json
Format:
  {"sets": {id: [Name_de, Name_en, Serie_de, SerieId, Erscheinungsdatum, offizielle Anzahl, Gesamtanzahl]},
   "cards": {"de": [[id, Nummer, Name, hatBild], ...], "en": [...]}}
"""
import json, sys, time, urllib.request, urllib.error

API = 'https://api.tcgdex.net/v2'
out = sys.argv[1]


def get(path, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(f'{API}/{path}', headers={'User-Agent': 'collector-catalog/1.0'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            err = e
        except Exception as e:  # Netzwerkfehler: kurz warten und erneut versuchen
            err = e
        time.sleep(min(5 * (i + 1), 30))
    print('übersprungen:', path, err)
    return None


sets, cards = {}, {'de': [], 'en': []}
for lang in ('de', 'en'):
    brief = get(f'{lang}/sets') or []
    if not brief:
        sys.exit(f'Setliste {lang} nicht geladen.')
    print(lang, len(brief), 'Sets')
    for b in brief:
        sid = b['id']
        d = get(f'{lang}/sets/{sid}')
        if not d:
            continue
        cc = d.get('cardCount') or {}
        e = sets.setdefault(sid, ['', '', '', '', '', 0, 0])
        if lang == 'de':
            e[0] = d.get('name', '')
            e[2] = (d.get('serie') or {}).get('name', '')
        else:
            e[1] = d.get('name', '')
            if not e[2]:
                e[2] = (d.get('serie') or {}).get('name', '')
        e[3] = e[3] or (d.get('serie') or {}).get('id', '')
        e[4] = e[4] or d.get('releaseDate', '') or ''
        e[5] = e[5] or cc.get('official') or 0
        e[6] = max(e[6], cc.get('total') or 0)
        for c in d.get('cards') or []:
            cards[lang].append([c['id'], c.get('localId', ''), c.get('name', ''), 1 if c.get('image') else 0])
        time.sleep(0.3)

if len(sets) < 50:
    sys.exit('Zu wenige Sets geladen, Katalog wird nicht überschrieben.')
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'sets': sets, 'cards': cards}, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
print(len(sets), 'Sets,', len(cards['de']), 'Karten (de),', len(cards['en']), 'Karten (en)')
