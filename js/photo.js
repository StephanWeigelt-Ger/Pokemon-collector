// Fotoverbesserung direkt auf dem Gerät.
// Ziel: Helligkeit und Kontrast optimieren und Glanzlichter/Reflexionen abschwächen.
// Feine Strukturen (Knicke, Kratzer, gestauchte Ecken) bleiben bewusst erhalten:
// Es wird nichts wegretuschiert, sondern nur Tonwerte und großflächige Spiegelungen angepasst.

const MAX_SIDE = 2000;
const THUMB_SIDE = 240;

export async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* Fallback */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
    img.src = URL.createObjectURL(file);
  });
}

export function toCanvas(img, maxSide = MAX_SIDE) {
  const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * scale);
  c.height = Math.round(h0 * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// Separierbarer Box-Blur auf einem Float32-Kanal (mehrfach angewendet ≈ Gauß)
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc / d;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / d;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
const blur = (a, w, h, r) => boxBlur(boxBlur(a, w, h, r), w, h, r);

function percentile(hist, total, p) {
  let acc = 0;
  for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= total * p) return i; }
  return hist.length - 1;
}

export function enhance(canvas, opts = {}) {
  const { glare = 0.8 } = opts;
  const w = canvas.width, h = canvas.height, n = w * h;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), L = new Float32Array(n);
  const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256), histL = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2];
    R[i] = r / 255; G[i] = g / 255; B[i] = b / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    L[i] = l / 255;
  }

  // 1) Reflexionen. Eine Spiegelung wirkt wie ein weißer Schleier: beobachtet = echt·(1−a) + Weiß·a.
  // Kräftige Packungsfarben haben fast immer einen dunklen Farbkanal; ein Schleier hebt genau diesen
  // "dunklen Kanal" an. Wir messen, wie stark er gegenüber der Umgebung angehoben ist, und rechnen den
  // Schleier pixelweise heraus. Die Rechnung ist je Pixel linear, Knicke, Kratzer und Druckstellen
  // bleiben deshalb vollständig sichtbar; nichts wird ersetzt oder wegretuschiert.
  const side = Math.max(w, h);
  const rSmall = Math.max(1, Math.round(side / 600));
  const dc = new Float32Array(n);
  for (let i = 0; i < n; i++) dc[i] = Math.min(R[i], G[i], B[i]);
  const dcLoc = blur(dc, w, h, Math.max(2, rSmall * 4));
  const dcBig = blur(dc, w, h, Math.max(4, Math.round(side / 8)));
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lift = Math.min(1, Math.max(0, (dcLoc[i] - dcBig[i] - 0.03) / 0.12));
    const bright = Math.min(1, Math.max(0, (L[i] - 0.4) / 0.2));
    mask[i] = lift * bright;
  }
  // weiche Maske (kein harter Schwellwert, damit keine sichtbaren Kanten entstehen)
  const m = blur(mask, w, h, Math.max(2, Math.round(side / 70)));
  let glareShare = 0;
  for (let i = 0; i < n; i++) { m[i] = Math.min(1, m[i] * 1.8); glareShare += m[i]; }
  glareShare /= n;

  if (glare > 0 && glareShare > 0.002) {
    // Grundniveau des dunklen Kanals aus der Umgebung ohne Spiegelung (normalisierte Faltung, mehrere Radien)
    const wgt = new Float32Array(n);
    for (let i = 0; i < n; i++) wgt[i] = (1 - m[i]) * (1 - m[i]);
    const radii = [side / 40, side / 15, side / 6].map((r) => Math.max(3, Math.round(r)));
    const wsSum = new Float32Array(n), base = new Float32Array(n);
    const dw = new Float32Array(n);
    for (let i = 0; i < n; i++) dw[i] = dc[i] * wgt[i];
    for (const r of radii) {
      const ws = blur(wgt, w, h, r), sl = blur(dw, w, h, r);
      for (let i = 0; i < n; i++) { wsSum[i] += ws[i]; base[i] += sl[i]; }
    }
    for (let i = 0; i < n; i++) {
      if (m[i] <= 0.01) continue;
      const b0 = wsSum[i] > 1e-4 ? base[i] / wsSum[i] : dcBig[i];
      let a = (dcLoc[i] - b0) / (1 - b0 + 1e-3);
      a = Math.min(0.85, Math.max(0, a)) * Math.min(1, m[i] * 3) * glare;
      if (a <= 0) continue;
      const inv = 1 / (1 - a);
      R[i] = Math.max(0, (R[i] - a) * inv);
      G[i] = Math.max(0, (G[i] - a) * inv);
      B[i] = Math.max(0, (B[i] - a) * inv);
      L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    }
  }

  for (let i = 0; i < n; i++) {
    histR[Math.min(255, (R[i] * 255) | 0)]++; histG[Math.min(255, (G[i] * 255) | 0)]++; histB[Math.min(255, (B[i] * 255) | 0)]++;
    histL[Math.min(255, (L[i] * 255) | 0)]++;
  }

  // 2) Tonwerte: Schwarz-/Weißpunkt aus Helligkeit, leichte Farbstichkorrektur pro Kanal
  const lo = percentile(histL, n, 0.005) / 255, hi = Math.max(lo + 0.2, percentile(histL, n, 0.995) / 255);
  const ch = [histR, histG, histB].map((hh) => [percentile(hh, n, 0.005) / 255, percentile(hh, n, 0.995) / 255]);

  // Helligkeit: mittlere Helligkeit Richtung ~0,5 bringen (Gamma)
  let mean = 0;
  for (let i = 0; i < n; i++) mean += Math.min(1, Math.max(0, (L[i] - lo) / (hi - lo)));
  mean /= n;
  const gamma = Math.min(1.5, Math.max(0.65, Math.log(0.5) / Math.log(Math.min(0.95, Math.max(0.05, mean)))));

  const contrast = 3.0; // sanfte S-Kurve
  const sig = (x) => 1 / (1 + Math.exp(-contrast * (x - 0.5)));
  const s0 = sig(0), s1 = sig(1);
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    const x = Math.pow(i / 1023, gamma);
    const y = (sig(x) - s0) / (s1 - s0);
    curve[i] = 0.45 * y + 0.55 * x;
  }
  const chans = [R, G, B];
  for (let c = 0; c < 3; c++) {
    const C = chans[c];
    // behutsam: Schwarz-/Weißpunkt nur teilweise anheben, damit keine Details absaufen
    const clo = 0.6 * (0.5 * lo + 0.5 * ch[c][0]), chiRaw = 0.5 * hi + 0.5 * ch[c][1];
    const chi = Math.max(clo + 0.2, chiRaw + (1 - chiRaw) * 0.4);
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, Math.max(0, (C[i] - clo) / (chi - clo)));
      C[i] = curve[(v * 1023) | 0];
    }
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    px[j] = R[i] * 255; px[j + 1] = G[i] * 255; px[j + 2] = B[i] * 255;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').putImageData(img, 0, 0);
  out.glareShare = glareShare;
  return out;
}

export function canvasToBlob(canvas, quality = 0.88) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export function thumbnail(canvas) {
  const s = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75);
}
