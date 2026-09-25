// core.js — разбор скриншота расписания. Чистый JS: работает и в браузере, и в Node.
// Изображение: {w, h, c, data}; c = 4 (RGBA) или 1 (серое). OCR передаётся снаружи (см. ocr.js).

export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS = {
  январь: 1, февраль: 2, март: 3, апрель: 4, май: 5, июнь: 6, июль: 7, август: 8, сентябрь: 9, октябрь: 10, ноябрь: 11, декабрь: 12,
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

// ---------- нечёткое сравнение (как rapidfuzz.fuzz.ratio: 2*LCS/(|a|+|b|)*100)
export function ratio(a, b) {
  if (!a.length && !b.length) return 100;
  let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++)
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return (2 * prev[b.length] / (a.length + b.length)) * 100;
}

// ---------- примитивы изображения
// бикубическая интерполяция (a = -0.75, как в OpenCV): текст остаётся чётче, чем при билинейной
const cubicW = (x) => { x = Math.abs(x); const a = -0.75;
  return x <= 1 ? ((a + 2) * x - (a + 3)) * x * x + 1 : x < 2 ? (((x - 5) * x + 8) * x - 4) * a : 0; };

export function resize(src, nw, nh) {
  const { w, h, c, data } = src, out = new Uint8Array(nw * nh * c), sx = w / nw, sy = h / nh;
  const axis = (n, size, scale) => Array.from({ length: n }, (_, i) => {
    const f = (i + 0.5) * scale - 0.5, i0 = Math.floor(f), t = f - i0;
    return { idx: [-1, 0, 1, 2].map((k) => Math.min(size - 1, Math.max(0, i0 + k))), wt: [-1, 0, 1, 2].map((k) => cubicW(t - k)) };
  });
  const xs = axis(nw, w, sx), ys = axis(nh, h, sy);
  for (let y = 0; y < nh; y++) {
    const { idx: yi, wt: yw } = ys[y];
    for (let x = 0; x < nw; x++) {
      const { idx: xi, wt: xw } = xs[x];
      for (let k = 0; k < c; k++) {
        let acc = 0;
        for (let j = 0; j < 4; j++) {
          let row = 0;
          for (let i = 0; i < 4; i++) row += data[(yi[j] * w + xi[i]) * c + k] * xw[i];
          acc += row * yw[j];
        }
        out[(y * nw + x) * c + k] = acc < 0 ? 0 : acc > 255 ? 255 : Math.round(acc);
      }
    }
  }
  return { w: nw, h: nh, c, data: out };
}

function toGray({ w, h, data }) {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = Math.round(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114);
  return { w, h, c: 1, data: g };
}

function otsu(arr) {
  const hist = new Array(256).fill(0);
  for (const v of arr) hist[v]++;
  const total = arr.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const d = sumB / wB - (sum - sumB) / wF, between = wB * wF * d * d;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function crop(img, x0, x1, y0, y1, inset = 3) {
  const xa = Math.max(0, Math.floor(x0) + inset), xb = Math.min(img.w, Math.floor(x1) - inset);
  const ya = Math.max(0, Math.floor(y0) + inset), yb = Math.min(img.h, Math.floor(y1) - inset);
  const w = Math.max(0, xb - xa), h = Math.max(0, yb - ya), c = img.c, out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++)
    out.set(img.data.subarray(((ya + y) * img.w + xa) * c, ((ya + y) * img.w + xa + w) * c), y * w * c);
  return { w, h, c, data: out };
}

function pad(g, n, value) {
  const w = g.w + 2 * n, h = g.h + 2 * n, out = new Uint8Array(w * h).fill(value);
  for (let y = 0; y < g.h; y++) out.set(g.data.subarray(y * g.w, (y + 1) * g.w), (y + n) * w + n);
  return { w, h, c: 1, data: out };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- сетка таблицы
function peaks(proj, thr, gap = 2) {
  const groups = [];
  proj.forEach((v, i) => {
    if (v <= thr) return;
    const g = groups[groups.length - 1];
    if (g && i - g[g.length - 1] <= gap) g.push(i); else groups.push([i]);
  });
  return groups.map((g) => Math.trunc(g.reduce((s, x) => s + x, 0) / g.length));
}

function fitLines(pos, pitch0, iters = 4) {
  const fit = (pts, a, p) => {
    for (let it = 0; it < iters; it++) {
      const ks = pts.map((v) => Math.round((v - a) / p));
      if (new Set(ks).size < 2) break;
      const n = ks.length, sk = ks.reduce((s, x) => s + x, 0), sv = pts.reduce((s, x) => s + x, 0);
      const skk = ks.reduce((s, x) => s + x * x, 0), skv = ks.reduce((s, x, i) => s + x * pts[i], 0);
      p = (n * skv - sk * sv) / (n * skk - sk * sk);
      a = (sv - p * sk) / n;
    }
    return [a, p];
  };
  let [a, p] = fit(pos, pos[0], pitch0);
  const good = pos.filter((v) => { const k = Math.round((v - a) / p); return Math.abs(v - (a + p * k)) <= 0.2 * p; });
  return good.length >= 3 && good.length < pos.length ? fit(good, good[0], p) : [a, p];
}

// типичный шаг: наименьшее расстояние, которое встречается достаточно часто (случайные лишние линии не мешают)
function typicalPitch(pos) {
  const d = pos.slice(1).map((v, i) => v - pos[i]).filter((x) => x >= 15).sort((a, b) => a - b);
  for (const v of d) {
    const near = d.filter((x) => Math.abs(x - v) <= 0.15 * v);
    if (near.length >= 0.3 * d.length) return median(near);
  }
  return null;
}

export function detectGrid(img) {
  const { w, h, data } = img, colRun = new Float64Array(w);
  const neutral = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    neutral[i] = Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && r > 190 && r < 245 ? 1 : 0;
  }
  for (let x = 0; x < w; x++) {                       // вертикальные отрезки длиной >= 15
    let run = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && neutral[y * w + x]) run++; else { if (run >= 15) colRun[x] += run; run = 0; }
    }
  }
  const vx = peaks(Array.from(colRun, (v) => v / h), 0.3).filter((x) => x > 0.03 * w);
  if (vx.length < 3) throw new Error("Не нашёл линии таблицы — это точно скриншот расписания?");

  const pitchX = median(vx.slice(1).map((v, i) => v - vx[i]));
  // границы строк: строка пикселей, где почти во всех колонках меняется цвет (текст даёт лишь часть колонок).
  // Так линии находятся и когда они бледные после уменьшения скриншота.
  const x0 = vx[0] + 2, edge = new Float64Array(h);
  for (let y = 0; y < h - 1; y++) {
    let cnt = 0;
    for (let x = x0; x < w - 2; x++) {
      const i = (y * w + x) * 4, j = i + w * 4;
      if (Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) > 24) cnt++;
    }
    edge[y] = cnt / (w - 2 - x0);
  }
  const top = [...edge].sort((a, b) => a - b)[Math.floor(h * 0.97)];   // порог относительно самых чётких линий
  const hy = peaks(edge, 0.8 * top, Math.max(2, Math.round(pitchX * 0.295 * 0.1)));   // толстые линии на крупных скриншотах не должны дробиться

  const labelX = vx[0];
  const [ax, px] = fitLines(vx, pitchX);
  const nCols = Math.round((w - ax) / px);
  const xs = Array.from({ length: nCols + 1 }, (_, k) => ax + px * k);

  const p0 = hy.length >= 3 ? typicalPitch(hy) : null;
  let ay = 1, py = px * 0.295;
  if (p0) [ay, py] = fitLines(hy, p0);
  const nRows = Math.round((h - ay) / py);
  const ys = Array.from({ length: nRows + 1 }, (_, k) => ay + py * k);
  return { xs, ys, labelX };
}

// ---------- подготовка ячеек для OCR
function textMask(cell) {
  const { w, h, data } = cell;
  if (w < 4 || h < 4) return null;
  const ring = [];
  for (let x = 0; x < w; x++) { ring.push((x) * 4, ((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y++) { ring.push((y * w) * 4, (y * w + w - 1) * 4); }
  const bg = [0, 1, 2].map((k) => median(ring.map((i) => data[i + k])));
  const d8 = new Uint8Array(w * h);
  let max = 0;
  for (let i = 0; i < w * h; i++) {
    const d = Math.hypot(data[i * 4] - bg[0], data[i * 4 + 1] - bg[1], data[i * 4 + 2] - bg[2]);
    if (d > max) max = d;
    d8[i] = Math.min(255, d);
  }
  if (max < 60) return null;                          // пустая ячейка
  const t = otsu(d8);
  let x0 = w, x1 = -1, y0 = h, y1 = -1, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d8[y * w + x] > t) { count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (count < 15) return null;
  const mw = x1 - x0 + 1, mh = y1 - y0 + 1, out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) out[y * mw + x] = d8[(y + y0) * w + x + x0] > t ? 255 : 0;
  return { w: mw, h: mh, c: 1, data: out };
}

function prepareMask(mask) {                          // чёрный текст на белом, высота 48, поля
  const nh = 48, big = resize(mask, Math.max(1, Math.floor(mask.w * nh / mask.h)), nh);
  const padded = pad(big, 14, 0);
  return { ...padded, data: padded.data.map((v) => 255 - v) };
}

function preparePlain(cellRgba, scale = 4) {          // серый + Otsu: подписи и даты
  const g = toGray(cellRgba), big = resize(g, g.w * scale, g.h * scale), t = otsu(big.data);
  let bin = big.data.map((v) => (v > t ? 255 : 0));
  if (bin.reduce((s, v) => s + v, 0) / bin.length < 127) bin = bin.map((v) => 255 - v);
  return pad({ w: big.w, h: big.h, c: 1, data: bin }, 20, 255);
}

function isBlank(cell) {
  if (cell.w < 2 || cell.h < 2) return true;
  const g = toGray(cell).data, mean = g.reduce((s, v) => s + v, 0) / g.length;
  return Math.sqrt(g.reduce((s, v) => s + (v - mean) ** 2, 0) / g.length) < 8;
}

const clean = (t) => t.split(/\s+/).filter(Boolean).join(" ");
const hasLetters = (t) => /[А-Яа-яЁё]/.test(t);

function hashBytes(arr) {
  let h = 2166136261;
  for (const v of arr) { h ^= v; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

// ---------- разбор структуры
function clusterLabels(labels, threshold = 70) {
  const canon = [], counts = [], idx = [];
  for (const text of labels) {
    let found = -1;
    for (let i = 0; i < canon.length; i++) {
      if (text && ratio(text.toLowerCase(), canon[i].toLowerCase()) >= threshold) { found = i; break; }
    }
    if (found < 0) { canon.push(text); counts.push(new Map([[text, 1]])); found = canon.length - 1; }
    else counts[found].set(text, (counts[found].get(text) || 0) + 1);
    idx.push(found);
  }
  const best = counts.map((m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return idx.map((i) => best[i]);
}

const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const iso = (d) => d.toISOString().slice(0, 10);

function parseDate(text, prev, year) {
  const dm = /\d{1,2}/.exec(text);
  if (!dm) return null;
  const day = +dm[0], word = text.toLowerCase().replace(/[^а-яё]/g, "");
  let month = null;
  if (word) {
    const best = Object.keys(MONTHS).reduce((a, b) => (ratio(word, b) > ratio(word, a) ? b : a));
    if (ratio(word, best) >= 70) month = MONTHS[best];
  }
  if (month == null && prev) month = day >= prev.getUTCDate() ? prev.getUTCMonth() + 1 : (prev.getUTCMonth() + 1) % 12 + 1;
  if (month == null) return null;
  let y = prev ? prev.getUTCFullYear() : year;
  if (prev && month < prev.getUTCMonth() + 1) y += 1;
  const d = utc(y, month, day);
  return d.getUTCDate() === day ? d : null;
}

// ---------- главная функция
export async function parseSchedule(input, ocr, { year = new Date().getFullYear(), onProgress = () => {} } = {}) {
  let img = input;
  if (img.w < 1500) img = resize(img, 1500, Math.round(img.h * 1500 / img.w));   // мелкий текст плохо читается
  const grid = detectGrid(img), nRows = grid.ys.length - 1, nCols = grid.xs.length - 1;
  const cell = (r, c) => crop(img, grid.xs[c], grid.xs[c + 1], grid.ys[r], grid.ys[r + 1]);
  const cache = new Map();

  const readCell = async (cl) => {
    const mask = textMask(cl);
    if (!mask) return "";
    const prep = prepareMask(mask), key = hashBytes(resize(prep, 96, 32).data);
    if (!cache.has(key)) cache.set(key, (async () => {
      for (const psm of [7, 8, 13]) {                 // не прочиталось — другой режим сегментации
        const t = clean(await ocr.text(prep, psm));
        if (hasLetters(t)) return t;
      }
      return "";
    })());
    return cache.get(key);
  };
  const readPlain = async (cl) => (isBlank(cl) ? "" : clean(await ocr.text(preparePlain(cl), 7)));
  const readTime = async (cl) => {
    if (isBlank(cl)) return null;
    for (const s of [4, 6, 8, 3]) {                   // цифры — строгим проходом, при неудаче другой масштаб
      const m = /^(\d{1,2}):(\d{2})$/.exec((await ocr.digits(preparePlain(cl, s))).trim());
      if (m) return `${String(+m[1]).padStart(2, "0")}:${m[2]}`;
    }
    return null;
  };

  onProgress("Читаю подписи и даты…", 0.05);
  const labelImgs = Array.from({ length: nRows }, (_, r) => crop(img, 0, grid.labelX, grid.ys[r], grid.ys[r + 1]));
  const times = await Promise.all(labelImgs.map(readTime));
  const labels = await Promise.all(labelImgs.map((im, i) => (times[i] ? "" : readPlain(im))));
  const dateTexts = await Promise.all(Array.from({ length: nCols }, (_, c) => readPlain(cell(0, c))));

  // даты идут подряд: каждая прочитанная голосует за первый день, побеждает большинство
  const votes = new Map();
  let prev = null;
  dateTexts.forEach((t, i) => {
    const d = parseDate(t, prev, year);
    if (d) { const k = iso(addDays(d, -i)); votes.set(k, (votes.get(k) || 0) + 1); prev = d; }
  });
  if (!votes.size) throw new Error("Не смог прочитать даты в шапке таблицы.");
  const first = new Date([...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] + "T00:00:00Z");
  const dates = Array.from({ length: nCols }, (_, i) => addDays(first, i));

  // строка со временем = смены; подпись, встречающаяся несколько раз («Домик») = место; уникальная = секция
  const canon = clusterLabels(labels), freq = new Map();
  canon.forEach((n, i) => { if (labels[i]) freq.set(n, (freq.get(n) || 0) + 1); });
  let section = "", place = "";
  const rows = [];
  labels.forEach((raw, r) => {
    if (times[r]) rows.push({ r, section, place, time: times[r] });
    else if (raw) { if (freq.get(canon[r]) > 1) place = canon[r]; else { section = canon[r]; place = ""; } }
  });

  const coords = rows.flatMap(({ r }) => Array.from({ length: nCols }, (_, c) => [r, c]));
  let done = 0;
  let texts = await Promise.all(coords.map(async ([r, c]) => {
    const t = await readCell(cell(r, c));
    onProgress("Читаю имена…", 0.1 + 0.9 * (++done / coords.length));
    return t;
  }));
  texts = clusterLabels(texts, 80);                   // поправка опечаток OCR: близкие написания -> самое частое
  const cells = new Map(coords.map(([r, c], i) => [`${r},${c}`, texts[i]]));
  return { dates, rows, cells };
}

// ---------- поиск смен
const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9 ]/g, "").trim();

function score(query, text) {
  const q = norm(query), t = norm(text);
  if (!q || !t) return 0;
  let best = ratio(q, t);
  const qt = q.split(" "), tt = t.split(" ");
  if (qt.length === 1) best = Math.max(best, ratio(qt[0], tt[0]));   // «Хава» найдёт «Хава Б.»
  return best;
}

export const partOfDay = (time) => { const h = +time.split(":")[0]; return h < 6 ? "ночь" : h < 14 ? "утро" : "вечер"; };
export const weekday = (d) => WEEKDAYS[(d.getUTCDay() + 6) % 7];
export const dayMonth = (d) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export function findShifts(sch, name, threshold = 75) {
  const out = [];
  for (const { r, section, place, time } of sch.rows) {
    sch.dates.forEach((date, c) => {
      const text = sch.cells.get(`${r},${c}`) || "", s = score(name, text);
      if (s >= threshold) out.push({ date, section, place, time, text, score: s });
    });
  }
  return out.sort((a, b) => a.date - b.date || a.time.localeCompare(b.time));
}

export function similarNames(sch, name, limit = 5) {
  const names = [...new Set([...sch.cells.values()].filter(Boolean))];
  return names.map((n) => [n, ratio(norm(name), norm(n))]).filter(([, s]) => s >= 40)
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n);
}

export const where = (s) => [s.section, s.place].filter(Boolean).join(" · ");
export const formatShifts = (shifts) => (shifts.length
  ? shifts.map((s) => `${dayMonth(s.date)} ${weekday(s.date)} — ${where(s)}, ${partOfDay(s.time)} (${s.time})`).join("\n")
  : "Смен не нашёл.");

export async function extractShifts(img, name, ocr, opts) {
  const schedule = await parseSchedule(img, ocr, opts);
  return { shifts: findShifts(schedule, name), schedule };
}
