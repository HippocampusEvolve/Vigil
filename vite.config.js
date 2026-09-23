import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConst } from 'node:zlib';
import { defineConfig } from 'vite';

// Три плагина ниже - общие для миров find-the-end.fun и перенесены из Winter
// Tower копией, в том же порядке. Числа в комментариях - замеры того мира:
// механизм тот же, а моделей и текстур у этого мира нет вовсе, всё собирается
// кодом.

// ---------------------------------------------------------------------------
// Штампы версий для файлов из public/
//
// У бандла Vite имя меняется вместе с содержимым, у карты камня — нет: модели
// и текстуры уезжают в сборку под своими именами. А nginx отдаёт их с
// `Cache-Control: immutable` на год, и immutable означает не «храни подольше»,
// а «даже не переспрашивай». Правка такого файла до вернувшегося игрока не
// доезжает вовсе — адрес-то прежний.
//
// Плагин считает хэш каждого файла в public/ и отдаёт таблицу бандлу, а
// src/asset.ts приклеивает штамп к адресу. Ключ браузерного кэша меняется
// вместе с файлом, и обновляется ровно то, что изменилось.
//
// В dev таблица пустая: там свои правила кэша, а хэш всё равно устаревал бы до
// перезапуска сервера.
// ---------------------------------------------------------------------------
const VIRTUAL = 'virtual:asset-stamps';

function stampsOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path).split(sep).join('/')] =
        createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 8);
    }
  };
  walk(dir);
  return out;
}

export function assetStamps(dir = 'public') {
  let stamps = {};
  let live = false;
  return {
    name: 'asset-stamps',
    configResolved(config) {
      live = config.command === 'build';
    },
    buildStart() {
      stamps = live ? stampsOf(dir) : {};
      if (live) console.log(`[stamps] ${Object.keys(stamps).length} файлов из ${dir}/`);
    },
    resolveId(id) {
      return id === VIRTUAL ? `\0${VIRTUAL}` : null;
    },
    load(id) {
      return id === `\0${VIRTUAL}` ? `export default ${JSON.stringify(stamps)}` : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Service worker: второй приход в мир без сети.
//
// Плагин читает `sw-template.js` из корня игры, подставляет в него базовый
// путь, версию сборки и список файлов оболочки, и кладёт готовый `sw.js`
// рядом с бандлом. Сам шаблон в сборку не импортируется - иначе Vite разобрал
// бы его как модуль страницы, а он исполняется в worker'е.
//
// Версия считается по ИМЕНАМ бандлов, а они несут хэш содержимого: изменилась
// хоть строчка в мире - изменилось имя, значит и версия. Штампы файлов из
// public/ тоже лежат внутри бандла (см. assetStamps выше), так что новая
// текстура меняет версию ровно так же, как новый код.
//
// В dev плагин молчит: там нет ни бандлов, ни постоянных имён, а закэшированный
// worker'ом dev-сервер - это полдня поиска того, почему правка не видна.
// ---------------------------------------------------------------------------
export function serviceWorker() {
  let base = '/';
  // Штамп boot.js в его адресе. Без него первый заход после выкладки получал
  // СМЕСЬ версий: старый worker ещё у руля, страницу он берёт с сервера
  // (новую), а boot.js - из своего кэша оболочки (старый), и мир зовёт
  // сторож, которого в старом файле нет. Новый адрес в старом кэше не
  // найдётся, и worker честно сходит за ним в сеть.
  const bootHash = createHash('sha1')
    .update(readFileSync(new URL('./public/boot.js', import.meta.url)))
    .digest('hex')
    .slice(0, 8);
  const htmlHash = createHash('sha1')
    .update(readFileSync(new URL('./index.html', import.meta.url)))
    .digest('hex')
    .slice(0, 8);
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(`${base}boot.js"`, `${base}boot.js?v=${bootHash}"`);
      },
    },
    generateBundle(_options, bundle) {
      const scripts = Object.keys(bundle)
        .filter((f) => f.endsWith('.js'))
        .sort();
      // Оболочка: сама страница, отдельный boot и бандлы. Модели и текстуры
      // сюда НЕ входят - их кэширует worker по факту запроса (sw-template.js).
      const shell = [base, `${base}boot.js?v=${bootHash}`, ...scripts.map((f) => base + f)];
      // Версия: бандлы, boot и сама страница. Правка одного html раньше версию
      // не меняла, и старый worker оставался у руля со старым кэшем оболочки.
      const version = createHash('sha1')
        .update([...scripts, bootHash, htmlHash].join('|'))
        .digest('hex')
        .slice(0, 8);
      const source = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8')
        .replace(/__SCOPE__/g, base)
        .replace(/__VERSION__/g, version)
        .replace(/__SHELL__/g, JSON.stringify(shell));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      console.log(`[sw] версия ${version}, оболочка из ${shell.length} файлов`);
    },
  };
}

// ---------------------------------------------------------------------------
// Предсжатие: brotli кладётся рядом с файлами прямо в сборке.
//
// Простая идея. Раньше nginx жал каждый ответ заново — на каждый запрос, для
// каждого посетителя. Бандл движка здесь 965 КБ (three и
// postprocessing вместе), и сжать их brotli даже на щадящем уровне стоит
// времени: на прогретом соединении файл начинал уходить заметно позже, чем
// несжимаемая модель рядом. Разница и есть работа сжатия, и на одноядерной
// машине она умножается на число пришедших разом.
//
// Сжать один раз при сборке — значит не платить ни разу при раздаче. Заодно
// становится доступен brotli 11: на лету такой уровень не включают, он слишком
// медленный, а в сборке лишние секунды никого не трогают. Бандл движка выходит
// 230 КБ вместо 258.
//
// На сервере это включается директивой `brotli_static on`
// (ops/hardening/13-nginx.sh в репозитории find-the-end.fun): nginx сам смотрит, лежит ли рядом с файлом
// `.br`, и отдаёт его вместо того, чтобы жать. Не лежит — жмёт по-старому,
// поэтому сборка без предсжатия остаётся рабочей.
//
// Спутника для gzip не кладём. Он весил бы ещё две с половиной сотни
// килобайт на каждую выкладку ради браузеров, которые не понимают brotli, а
// таких среди живых не осталось: Chrome понимает с 2016 года, Safari с 2017.
// Тому единственному, кто придёт без brotli, nginx сожмёт gzip'ом на лету,
// как и раньше.
//
// Сжимаем и модели: `.glb` отдаётся как application/octet-stream, и в списки
// типов для сжатия на лету этот тип не входит намеренно — пропускать через
// brotli мегабайтный буфер на каждый запрос было бы хуже, чем не сжимать
// вовсе. А один раз при сборке — можно, и лопата от этого выигрывает треть.
//
// Текстур это не касается: webp сжат внутри себя, и второй проход по нему —
// чистая трата. Они и не попадают, список PACKED ниже их отсекает.
// ---------------------------------------------------------------------------

// Форматы, которые уже сжаты внутри себя: второй проход даёт проценты, а
// место и время занимает целиком. Draco-геометрия сюда не входит осознанно —
// она в .glb, и по нему решает не расширение, а замер ниже.
const PACKED = new Set([
  '.webp', '.png', '.jpg', '.jpeg', '.avif', '.gif',
  '.mp4', '.webm', '.mp3', '.ogg', '.woff', '.woff2',
  '.br', '.gz', '.zip',
]);

// Ниже килобайта сжимать нечего: ответ и так уходит одним пакетом. То же
// число стоит в gzip_min_length и brotli_min_length на сервере.
const MIN_SIZE = 1024;

// Класть спутника рядом стоит, только если он заметно легче оригинала. Иначе
// в сборке появляется файл, ради которого nginx делает лишний stat, а
// посетитель экономит полпроцента. Пять процентов — та граница, ниже которой
// выигрыш перестаёт стоить второго файла.
const MIN_WIN = 0.95;

const brotliAsync = promisify(brotliCompress);

export function precompress() {
  let outDir = 'dist';
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    // closeBundle, а не writeBundle: public/ Vite копирует позже бандла, и в
    // writeBundle моделей на диске ещё нет.
    async closeBundle() {
      const files = [];
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          const st = statSync(path);
          if (st.isDirectory()) walk(path);
          else if (st.size >= MIN_SIZE && !PACKED.has(name.slice(name.lastIndexOf('.'))))
            files.push({ path, size: st.size });
        }
      };
      walk(outDir);

      let raw = 0;
      let packed = 0;
      let made = 0;
      await Promise.all(
        files.map(async (file) => {
          const data = readFileSync(file.path);
          const br = await brotliAsync(data, {
            params: {
              [zlibConst.BROTLI_PARAM_QUALITY]: 11,
              [zlibConst.BROTLI_PARAM_SIZE_HINT]: data.length,
            },
          });
          if (br.length > data.length * MIN_WIN) return;
          writeFileSync(`${file.path}.br`, br);
          raw += data.length;
          packed += br.length;
          made += 1;
        })
      );
      const mb = (n) => (n / 1048576).toFixed(2);
      console.log(
        `[precompress] ${made} файлов: ${mb(raw)} -> ${mb(packed)} МБ brotli ` +
          `(-${raw ? (100 - (packed / raw) * 100).toFixed(0) : 0}%)`
      );
    },
  };
}

// base: прод-сборка живёт на https://find-the-end.fun/vigil/, dev - на корне,
// чтобы localhost открывался без хвоста в адресе.
//
// Этот же путь прописан в сниппете nginx (ops/hardening/18-vigil.sh в
// репозитории find-the-end.fun) и в ссылке на карточке витрины: разойдутся -
// игра отдаст белый экран.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/vigil/' : '/',
  // У ядра (world-core) свой three в devDependencies, и без этой строки в
  // сборку могут попасть две копии движка: у мира и у контроллера окажутся
  // разные классы Vector3, а `instanceof` между ними ложен.
  resolve: { dedupe: ['three'] },
  build: {
    rollupOptions: {
      output: {
        // Движок отдельным файлом от кода мира. Раньше они лежали вместе, и
        // правка одной строки в игре меняла имя всего бандла: вернувшийся
        // игрок перекачивал девятьсот килобайт three и postprocessing,
        // которые не менялись месяцами.
        //
        // Функцией, а не таблицей: сборка идёт на rolldown, там таблица не
        // принимается вовсе (`manualChunks is not a function`).
        manualChunks(id) {
          const p = id.replace(/\\/g, '/');
          return p.includes('/node_modules/three/') ||
            p.includes('/node_modules/postprocessing/')
            ? 'three'
            : undefined;
        },
      },
    },
  },
  // precompress последним: он обходит готовую сборку, значит sw.js уже
  // выпущен, а public/ скопирован.
  plugins: [assetStamps(), serviceWorker(), precompress()],
}));
