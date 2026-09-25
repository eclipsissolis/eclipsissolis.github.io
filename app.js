import { extractShifts, formatShifts, similarNames, partOfDay, weekday, dayMonth, where } from "./src/core.js";
import { TesseractOcr } from "./src/ocr.js";

const $ = (id) => document.getElementById(id);
const drop = $("drop"), fileInput = $("file"), preview = $("preview"), out = $("out"), go = $("go"), nameEl = $("name");
let image = null, ocrPromise = null;

try { nameEl.value = localStorage.getItem("shift-name") || ""; } catch { /* хранилище недоступно — не страшно */ }

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---------- загрузка картинки
function setImage(f) {
  if (!f || !f.type.startsWith("image/")) return;
  image = f;
  preview.src = URL.createObjectURL(f);
  preview.style.display = "block";
  drop.classList.add("has");
}
drop.onclick = () => fileInput.click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } };
fileInput.onchange = () => setImage(fileInput.files[0]);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); setImage(e.dataTransfer.files[0]); };
document.onpaste = (e) => { for (const it of e.clipboardData.items) if (it.type.startsWith("image/")) setImage(it.getAsFile()); };
nameEl.onkeydown = (e) => { if (e.key === "Enter") go.click(); };

async function readPixels(file, maxWidth = 2000) {     // слишком большие картинки уменьшаем: быстрее и не хуже
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxWidth / bmp.width), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return { w, h, c: 4, data: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer) };
}

// ---------- OCR (создаётся один раз, при первом поиске)
function grayToCanvas(g) {
  const cv = document.createElement("canvas");
  cv.width = g.w; cv.height = g.h;
  const ctx = cv.getContext("2d"), id = ctx.createImageData(g.w, g.h);
  for (let i = 0; i < g.w * g.h; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = g.data[i]; id.data[i * 4 + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  return cv;
}
const getOcr = () => (ocrPromise ??= new TesseractOcr(window.Tesseract, {
  // все пути абсолютные и локальные: сам воркер работает на отдельном адресе (blob:),
  // поэтому относительные пути ему не подходят
  langPath: new URL("tessdata", location.href).href,
  corePath: new URL("vendor/tesseract/tesseract-core-lstm.wasm.js", location.href).href,
  workerPath: new URL("vendor/tesseract/worker.min.js", location.href).href,
  toInput: grayToCanvas,
  workers: Math.min(3, navigator.hardwareConcurrency || 2),
}).init().catch((e) => { ocrPromise = null; throw e; }));

// ---------- ошибки движка: tesseract.js бросает их «в пустоту» (мимо try/catch), поэтому ловим глобально,
// иначе кнопка навсегда зависает на «Загружаю распознавание…» без единого сообщения
let fatalReject = null;
const onFatal = (err) => fatalReject?.(err instanceof Error ? err : new Error(String(err)));
window.addEventListener("unhandledrejection", (e) => onFatal(e.reason));
window.addEventListener("error", (e) => onFatal(e.error || e.message));

const friendly = (msg) => (/traineddata|tessdata/i.test(msg)
  ? `Не найдены языковые данные (${msg}). Проверь, что папка tessdata с файлами rus.traineddata и eng.traineddata загружена в репозиторий.`
  : /vendor|worker|wasm|core/i.test(msg) ? `Не загрузился движок распознавания (${msg}). Проверь, что папка vendor/tesseract загружена целиком.` : msg);

// ---------- поиск смен
go.onclick = async () => {
  const name = nameEl.value.trim();
  if (!image) { out.innerHTML = '<p class="err">Сначала загрузи скриншот.</p>'; return; }
  if (!name) { out.innerHTML = '<p class="err">Напиши своё имя.</p>'; return; }
  try { localStorage.setItem("shift-name", name); } catch { /* ignore */ }

  go.disabled = true;
  const status = (text, frac) => { go.textContent = frac == null ? text : `${text} ${Math.round(frac * 100)}%`; };
  try {
    status("Загружаю распознавание…");
    out.innerHTML = '<p class="hint">При первом запуске нужно скачать языковые данные (~8 МБ), дальше они сохраняются в браузере.</p>';
    const fatal = new Promise((_, reject) => { fatalReject = reject; });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Распознавание не запустилось за 2 минуты")), 120000));
    const guard = (p) => Promise.race([p, fatal, timeout]);
    const [ocr, pixels] = await guard(Promise.all([getOcr(), readPixels(image)]));
    out.innerHTML = "";
    const { shifts, schedule } = await guard(extractShifts(pixels, name, ocr, { onProgress: status }));

    if (!shifts.length) {
      const sim = similarNames(schedule, name);
      out.innerHTML = `<p class="err">Не нашёл «${esc(name)}» в расписании.</p>` +
        (sim.length ? `<p class="hint">Похожие имена в таблице: ${sim.map(esc).join(", ")}</p>` : "");
      return;
    }
    out.innerHTML = `<p class="hint">Найдено смен: ${shifts.length}</p>` + shifts.map((s) => {
      const part = partOfDay(s.time);
      return `<div class="row"><span class="date">${dayMonth(s.date)}<small>${weekday(s.date)}</small></span>` +
        `<span class="badge" style="background:var(--${part});color:var(--${part}-t)">${part} ${s.time}</span>` +
        `<span class="where">${esc(where(s))}</span></div>`;
    }).join("") + '<button class="ghost" id="copy">Скопировать список</button>';
    $("copy").onclick = async (e) => { await navigator.clipboard.writeText(formatShifts(shifts)); e.target.textContent = "Скопировано ✓"; };
  } catch (e) {
    console.error(e);
    ocrPromise = null;                                  // после сбоя следующая попытка начнёт с чистого листа
    out.innerHTML = `<p class="err">Не получилось: ${esc(friendly(String(e.message || e)))}</p>`;
  } finally {
    fatalReject = null;
    go.disabled = false; go.textContent = "Найти мои смены";
  }
};
