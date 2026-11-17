"""Baut data/produkte.json aus den frei herunterladbaren Cardmarket-Daten
(Produktliste der versiegelten Produkte + Preisübersicht, Pokémon = Spiel 6).
Aufruf: python3 tools/build_pokemon_products.py data/produkte.json
Format: {"stand": "...", "produkte": [[idProduct, Name, Kategorie, idExpansion, Trend, Durchschnitt30, Ab-Preis, TCGplayer-Bild-ID], ...]}
Produktbilder: TCGplayer-Katalog über tcgcsv.com (einmal pro Lauf, ca. 220 Abfragen), per Namensvergleich zugeordnet.
"""
import json, re, sys, time, unicodedata, urllib.request

BASE = 'https://downloads.s3.cardmarket.com/productCatalog'
out = sys.argv[1]


def get(path):
    req = urllib.request.Request(f'{BASE}/{path}', headers={'User-Agent': 'collector-catalog/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


products = get('productList/products_nonsingles_6.json')['products']
guide = get('priceGuide/price_guide_6.json')
prices = {p['idProduct']: p for p in guide['priceGuides']}
CAT = {
    'Pokémon Booster': 'Booster', 'Pokémon Display': 'Display', 'Pokémon Elite Trainer Boxes': 'Top-Trainer-Box',
    'Pokémon Box Set': 'Box / Kollektion', 'Pokémon Tins': 'Tin', 'Pokémon Blisters': 'Blister',
    'Pokémon Theme Decks': 'Themendeck', 'Pokémon Coins': 'Münze', 'Pokémon Trainer Kits': 'Trainer-Kit',
    'Pokémon Lot': 'Lot', 'PCG Set': 'Set',
}
rows = []
for p in products:
    pg = prices.get(p['idProduct']) or {}
    r = lambda v: round(v, 2) if isinstance(v, (int, float)) else None
    rows.append([p['idProduct'], p['name'], CAT.get(p.get('categoryName'), p.get('categoryName') or ''), p.get('idExpansion'),
                 r(pg.get('trend')), r(pg.get('avg30')), r(pg.get('low'))])

# ---------- Produktbilder von TCGplayer (tcgcsv.com) ----------
def tcg(path):
    req = urllib.request.Request(f'https://tcgcsv.com/tcgplayer/3/{path}', headers={'User-Agent': 'collector-catalog/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)['results']

SYN = [(r'\bbooster pack\b', 'booster'), (r'\bpokemon\b', ''), (r'\bpokémon\b', ''), (r'\bsingle pack\b', '1 pack'),
       (r'\bexclusive\b', ''), (r'\bscarlet violet\b', ''), (r'\bsword shield\b', '')]

def toks(name):
    n = unicodedata.normalize('NFKD', name.lower()).encode('ascii', 'ignore').decode().replace('&', ' ').replace('-', ' ')
    n = re.sub(r'[^a-z0-9 ]+', ' ', n)
    for a, b in SYN:
        n = re.sub(a, b, n)
    return frozenset(n.split())

try:
    sealed = []
    for g in tcg('groups'):
        try:
            for p in tcg(f"{g['groupId']}/products"):
                if any(e.get('name') in ('Number', 'Rarity') for e in p.get('extendedData') or []):
                    continue
                sealed.append((toks(p['name']), p['productId']))
        except Exception as e:
            print('übersprungen:', g.get('name'), e)
        time.sleep(0.15)
    index = {}
    for t, pid in sealed:
        for w in t:
            index.setdefault(w, []).append((t, pid))
    found = 0
    for row in rows:
        t = toks(row[1])
        if not t:
            row.append(None); continue
        rare = min(t, key=lambda w: len(index.get(w, [])) or 10**9)
        best, score = None, 0.0
        for t2, pid in index.get(rare, []):
            j = len(t & t2) / len(t | t2)
            if j > score:
                best, score = pid, j
        row.append(best if score >= 0.75 else None)
        found += score >= 0.75
    print(found, 'Produktbilder zugeordnet von', len(rows))
except Exception as e:
    print('Produktbilder nicht geladen:', e)
    for row in rows:
        row.append(None)

if len(rows) < 1000:
    sys.exit('Zu wenige Produkte geladen, Datei wird nicht überschrieben.')
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'stand': guide.get('createdAt', ''), 'produkte': rows}, f, ensure_ascii=False, separators=(',', ':'))
print(len(rows), 'Produkte, Preisstand', guide.get('createdAt'))
