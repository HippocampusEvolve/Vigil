// Этот файл намеренно лежит в public, а не в src: Vite не объединяет его с
// main.js. Если основной bundle не загрузится или не разберётся, watchdog уже
// работает и не оставит человека перед бесконечной полосой.
//
// Он же держит экран входа, пока мира ещё нет. Порядок такой: страница
// открывается сразу с титулом, строкой настроения и полосой загрузки - и
// БОЛЬШЕ НИ С ЧЕМ. Кнопок до готовности мира на экране нет вовсе: пока мир
// собирается, нажимать нечего, а значит нечему и вязнуть под курсором.
// Кнопки проступают одним движением вместе с расходящимся туманом, уже
// полностью отзывчивые, - это и снимает старую жалобу «кнопка не работает».
//
// Прежде здесь жила обратная механика: кнопка была живой с первой секунды,
// принимала нажатие в ожидание («мир собирается») и хранила само событие до
// прихода мира. Она честно не теряла нажатие, но не могла сделать главного -
// ответить сразу: главный поток в это время занят сборкой, и наведение на
// кнопку отзывалось через полсекунды. Убрано целиком (03.09.2026): нет
// кнопки - нет и раннего нажатия, которое надо было бы держать.

const gate = document.getElementById('gate');
const fog = document.getElementById('fog');
const bar = document.getElementById('loadBar');
const fill = document.getElementById('loadFill');
const note = document.getElementById('loadNote');
const enter = document.getElementById('enter');
const reset = document.getElementById('resetWorld');
const msg = document.getElementById('bootMsg');

/** Сколько туман расходится, когда мир готов. Столько же стоит в CSS #fog. */
const UNVEIL_MS = 2000;

/** Человек попросил не двигать лишнего: полоса тогда идёт без хода, скачком. */
const REDUCED =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Ход по кадрам невозможен или не нужен: полоса тогда пишется прямо в цель. */
const STEPPED = REDUCED || typeof requestAnimationFrame !== 'function';

let ready = false; // мир собран и подхватил управление экраном
let failed = false;
let unveiled = false; // туман разошёлся и открыл мир за меню
let onEnter = null; // сюда мир кладёт свой обработчик, когда готов
let onReset = null;

document.body.classList.add('booting');
// Класс `booting` держит две вещи сразу, и обе про одно и то же состояние:
// пока туман сплошной, мир за ним не виден (рисовать его незачем) и кнопок на
// экране нет (нажимать нечего). Снимается он в `unveil`, а не в `ready`: между
// ними мир как раз и доодевается.

function fail(reason) {
  if (failed || unveiled) return;
  failed = true;
  onEnter = null;
  onReset = null;
  clearTimeout(watchdog);
  console.error('мир не собрался:', reason);
  document.body.classList.add('boot-failed');
  if (msg) {
    msg.textContent = 'Мир не загрузился. Проверь сеть и попробуй снова';
    msg.hidden = false;
  }
  if (!document.getElementById('bootRetry')) {
    const retry = document.createElement('button');
    retry.id = 'bootRetry';
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = 'повторить';
    retry.addEventListener('click', () => location.reload());
    enter?.after(retry);
    retry.focus({ preventScroll: true });
  }
}

// Кнопки до готовности мира скрыты разметкой (`body.booting`), поэтому сюда
// нажатие может прийти только когда мир уже взял экран. Обработчики всё равно
// висят здесь, а не в мире: узлы принадлежат оболочке, и мир их не ищет.
enter?.addEventListener('click', (ev) => {
  if (!onEnter) return;
  // Вход - это и есть конец ожидания: туман уходит вместе с ним, чем бы ни
  // была занята отделка. Иначе игрок оказался бы в мире за сплошной пеленой.
  unveil();
  onEnter(ev);
});

reset?.addEventListener('click', () => {
  onReset?.();
});

const watchdog = setTimeout(() => fail(new Error('загрузка не уложилась в 30 с')), 30000);

// Трасса загрузки: пара чисел на весь мир, зато загрузку больше не измеряют на
// глаз. Метки ставит main.js в узловых точках (мир собран, меню открыто,
// отделка приехала), снять их можно откуда угодно, включая прод:
// `copy(__FTE_BOOT__.trace())` в консоли.
const trace = [];

// ---------- полоса загрузки ----------
// Полоса ведётся ОТСЮДА и только отсюда, и ведётся ВО ВРЕМЕНИ, а не по
// событиям. Раньше ширина писалась прямо в момент вехи, и полоса шла рывками:
// стояла секунду, прыгала на десять процентов, снова стояла. Теперь у неё есть
// ЦЕЛЬ и есть ХОД к цели по кадрам - ширина меняется каждый кадр и никогда не
// прыгает.
//
// Цель берётся как большее из трёх:
//   - ВЕХИ. Каждая веха - шаг лестницы с затуханием: 32, 54, 69, 79, 86, 91 %.
//     Вех у мира несколько, они разные у разных миров, и заранее их число
//     неизвестно - поэтому шаг не делит остаток поровну, а откусывает от него
//     треть. Полоса от этого никогда не упирается в конец раньше времени.
//   - ДОЛИ ЗАГРУЗЧИКА. Мир, начав считать ресурсы, зовёт `progress(доля)`.
//   - ДРЕЙФ ВО ВРЕМЕНИ. Медленное сползание к концу просто оттого, что время
//     идёт. Он и держит обещание «полоса никогда не стоит на месте»: между
//     двумя вехами бывает и полторы секунды тишины, а стоящая полоса читается
//     как зависший мир.
//
// До `unveil` полоса не идёт дальше 95 %: конец принадлежит только собранному
// миру. `unveil` доводит её до края, и она тает вместе с `#boot`.
const DRIFT_TAU = 14; // с: постоянная времени дрейфа, 50 % примерно за 10 с
const DRIFT_CAP = 0.9; // дальше дрейф не ведёт - остаток берут вехи
const HOLD_CAP = 0.95; // потолок до `unveil`
const EASE_TAU = 0.35; // с: с какой мягкостью полоса догоняет цель
const CREEP = 0.015; // доли в секунду: минимальный ход, чтобы не замирала
const RATE = 0.5; // доли в секунду: потолок скорости, он же запрет на рывок
const FINISH_RATE = 0.5; // конец полосы идёт той же скоростью: рывка нет и там

let steps = 0;
let goal = 0; // куда полоса идёт
let shown = 0; // где она сейчас
let painted = -1; // последний записанный в DOM процент
let finishing = false;
let ticking = false;
let last = 0;
const startedAt = now();

function now() {
  return typeof performance === 'object' && performance ? performance.now() : Date.now();
}

/** Шаг лестницы вех: откусывает треть остатка, назад не ходит. */
function step() {
  steps += 1;
  aim(1 - Math.pow(0.68, steps));
}

/** Поднять цель. Назад цель не ходит никогда. */
function aim(value) {
  if (!(value > goal)) return;
  goal = value;
  if (STEPPED) write(Math.min(goal, finishing ? 1 : HOLD_CAP));
}

/** Записать ширину в DOM. Единственное место, которое трогает страницу. */
function write(value) {
  if (!bar || !fill) return;
  shown = value;
  bar.classList.add('known');
  fill.style.width = `${(value * 100).toFixed(2)}%`;
  const percent = Math.round(value * 100);
  if (percent === painted) return;
  painted = percent;
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(percent));
  bar.setAttribute('aria-valuetext', `мир собран на ${percent} процентов`);
}

/** Дрейф во времени: сам по себе не доходит до конца, но и не стоит. */
function drift(t) {
  return DRIFT_CAP * (1 - Math.exp(-t / DRIFT_TAU));
}

function tick(stamp) {
  if (failed) { ticking = false; return; }
  const dt = Math.min(0.05, Math.max(0, (stamp - last) / 1000));
  last = stamp;
  const cap = finishing ? 1 : HOLD_CAP;
  const target = Math.min(cap, Math.max(goal, drift((stamp - startedAt) / 1000)));
  const gap = target - shown;
  if (gap > 0) {
    // Три ограничителя разом: мягкое приближение к цели (чтобы не тормозила
    // рывком), минимальный ход (чтобы не замирала) и потолок скорости (чтобы
    // новая далёкая цель не дала скачка шире, чем глаз стерпит).
    const soft = gap * (1 - Math.exp(-dt / EASE_TAU));
    const rate = (finishing ? FINISH_RATE : RATE) * dt;
    write(shown + Math.min(gap, Math.max(soft, CREEP * dt), rate));
  }
  if (finishing && shown >= 0.9995) {
    ticking = false;
    write(1);
    return;
  }
  requestAnimationFrame(tick);
}

function run() {
  // Первым делом снять с полосы CSS-«дыхание»: оно нарисовано широким пятном
  // посередине, и переход от него к настоящей ширине читался бы как прыжок
  // назад. Дыхание остаётся только на случай, когда не приехал сам boot.js.
  write(0);
  if (ticking || STEPPED) return;
  ticking = true;
  last = now();
  requestAnimationFrame(tick);
}

/** Тихая подпись под полосой: что мир собирает прямо сейчас. Меняется fade'ом. */
let noteText = '';
let noteTimer = 0;
function setNote(text) {
  if (!note || !text || text === noteText) return;
  noteText = text;
  if (REDUCED || !noteText) {
    note.textContent = text;
    return;
  }
  clearTimeout(noteTimer);
  note.classList.add('fading');
  noteTimer = setTimeout(() => {
    note.textContent = text;
    note.classList.remove('fading');
  }, 240);
}

/**
 * Туман расходится и открывает собранный мир за меню. Идемпотентно.
 *
 * Отделено от `ready` намеренно (03.09.2026). Раньше туман снимался прямо в
 * `ready`, а `ready` мир зовёт рано - по первому кадру, когда за меню стоит
 * ещё голая поляна, и следующие две секунды в кадре доезжали изба, лес и
 * мебель. Снаружи это читалось так: туман разошёлся и показал стройку, а
 * меню на ней подвисало - самые тяжёлые задачи главного потока приходились
 * ровно на эти две секунды.
 *
 * Теперь сигналов два. `ready` - «мир встал на ноги, кнопки теперь его», и
 * это ещё веха, а не конец: полоса делает шаг. `unveil` - «мир собран
 * целиком», и вот здесь полоса доходит до края и тает, туман расступается, а
 * кнопки проступают - в этом порядке и с задержкой, прописанной в CSS.
 * Не путать с пробуждением (`awaken.js`): там просыпается мир, здесь
 * расступается подложка меню.
 */
function unveil() {
  if (failed || unveiled) return;
  unveiled = true;
  finishing = true;
  goal = 1;
  if (STEPPED) write(1);
  document.body.classList.remove('booting');
  document.body.classList.add('unveiled');
  document.body.classList.add('ready');
  document.getElementById('boot')?.setAttribute('aria-hidden', 'true');
  setTimeout(() => fog?.classList.add('gone'), UNVEIL_MS);
}

window.__FTE_BOOT__ = {
  /**
   * Мир собран и берёт экран входа на себя.
   *
   * Ничего не возвращает: до `unveil` кнопок на экране нет, а значит нет и
   * нажатия, сделанного раньше времени, которое надо было бы отдать миру.
   *
   * @param {object} [handlers]
   * @param {(ev: Event) => void} [handlers.enter] вход в мир
   * @param {() => void}          [handlers.reset] забыть мир и начать заново
   */
  ready(handlers = {}) {
    if (failed) return;
    ready = true;
    clearTimeout(watchdog);
    // Веха, а не конец: мир подхватил экран, но отделка ещё едет. Туман
    // снимает `unveil`, и до него полоса до края не доходит.
    step();
    onEnter = handlers.enter || null;
    onReset = handlers.reset || null;
  },
  /** Мир собран целиком: туман расходится, кнопки проступают. См. `unveil`. */
  unveil,
  /** Виден ли ещё экран входа: миру это нужно, чтобы не входить дважды. */
  gateOpen() {
    return !!gate && !gate.classList.contains('hidden');
  },
  /**
   * Отметить веху загрузки. Полоса при этом поднимает цель, см. выше.
   *
   * @param {string} name техническое имя вехи - оно уходит в трассу
   * @param {string} [label] человеческая подпись под полосой («изба», «лес»).
   *   Таблица соответствия живёт В МИРЕ, а не здесь: вехи у миров свои, и
   *   оболочка про их содержание ничего не знает и знать не должна.
   */
  mark(name, label) {
    trace.push([name, Math.round(now())]);
    step();
    if (label) setNote(label);
  },
  /**
   * Доля загруженного по счёту ресурсов: 0..1. Зовёт мир, когда его загрузчик
   * знает доли. Цель полосы берёт большее из этого и хода по вехам.
   */
  progress(fraction) {
    if (!(fraction >= 0)) return;
    aim(0.35 + 0.6 * Math.min(1, fraction));
  },
  /** Снять трассу: пары «веха, миллисекунды от открытия страницы». */
  trace() {
    return trace.slice();
  },
  /** Мир не собрался. Зовётся и отсюда, и снаружи. */
  fail,
};

run();

addEventListener('error', (event) => fail(event.error || new Error('ресурс не загрузился')), true);
addEventListener('unhandledrejection', (event) => fail(event.reason));
