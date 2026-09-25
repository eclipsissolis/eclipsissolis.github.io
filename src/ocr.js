// ocr.js — обёртка над tesseract.js: пул воркеров для текста (rus) и один воркер для цифр (eng).
// toInput(gray) превращает серое изображение {w,h,data} в то, что понимает tesseract.js
// (в браузере — canvas, в Node — PNG-буфер).

const TEXT_WHITELIST = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя0123456789.:- ";

class Pool {
  constructor(items) { this.free = [...items]; this.queue = []; }
  async run(fn) {
    const item = this.free.pop() ?? (await new Promise((resolve) => this.queue.push(resolve)));
    try { return await fn(item); }
    finally { const next = this.queue.shift(); if (next) next(item); else this.free.push(item); }
  }
}

export class TesseractOcr {
  constructor(Tesseract, { langPath, corePath, workerPath, toInput, workers = 3, gzip = false }) {
    Object.assign(this, { Tesseract, langPath, corePath, workerPath, toInput, workers, gzip });
  }

  async init() {
    const opts = {
      langPath: this.langPath, gzip: this.gzip,
      // без этих трёх путей tesseract.js по умолчанию идёт на cdn.jsdelivr.net — тот
      // может быть недоступен или медленно грузиться в некоторых сетях, поэтому весь движок
      // (воркер + wasm-ядро) держим в репозитории, ничего стороннего не скачивается
      corePath: this.corePath, workerPath: this.workerPath, workerBlobURL: false,
    };
    const make = async (lang, whitelist) => {
      const w = await this.Tesseract.createWorker(lang, 1, opts);
      await w.setParameters({ tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: "7" });
      w._psm = "7";
      return w;
    };
    this.textWorkers = await Promise.all(Array.from({ length: this.workers }, () => make("rus", TEXT_WHITELIST)));
    this.digitWorker = await make("eng", "0123456789:");
    this.textPool = new Pool(this.textWorkers);
    this.digitPool = new Pool([this.digitWorker]);
    return this;
  }

  async #recognize(pool, gray, psm) {
    return pool.run(async (w) => {
      if (w._psm !== String(psm)) { await w.setParameters({ tessedit_pageseg_mode: String(psm) }); w._psm = String(psm); }
      const { data } = await w.recognize(await this.toInput(gray));
      return data.text;
    });
  }

  text(gray, psm = 7) { return this.#recognize(this.textPool, gray, psm); }
  digits(gray) { return this.#recognize(this.digitPool, gray, 7); }

  async close() { await Promise.all([...this.textWorkers, this.digitWorker].map((w) => w.terminate())); }
}
