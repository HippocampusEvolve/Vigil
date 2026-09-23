/**
 * sound/dsp.ts - арифметика звука без WebAudio: то, чем петли считаются заранее.
 *
 * Дорогие постоянные текстуры (дождь, ручей, генератор) не собираются живым
 * графом из тысяч узлов, а считаются в массив один раз и потом играются по
 * кругу. Считать их можно ещё до рождения аудиоконтекста: нужна только частота
 * дискретизации. Поэтому здесь нет ни одного узла WebAudio - только числа.
 *
 * Всё, что считается долго, написано генераторами (`function*`): работа
 * отдаёт управление через каждые несколько тысяч отсчётов, и её можно резать на
 * порции по кадрам (`bank.ts`), не держа главный поток дольше бюджета.
 */

/** Посчитанный звук: массив отсчётов, который можно отдать в `AudioBuffer`. */
export type Samples = Float32Array<ArrayBuffer>

/** Децибелы в разы по амплитуде. */
export const db = (x: number): number => Math.pow(10, x / 20)

/**
 * Детерминированный генератор случайных чисел (mulberry32). Петли одинаковы от
 * запуска к запуску: так их можно мерить, и число в проверке не скачет оттого,
 * что дождь в этот раз выпал другим.
 */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Случайное между `a` и `b`, равномерно. */
export const between = (r: () => number, a: number, b: number): number => a + (b - a) * r()

/** Случайное между `a` и `b` равномерно по логарифму: частоты так и выбираются, октавами. */
export const logBetween = (r: () => number, a: number, b: number): number => a * Math.pow(b / a, r())

/** Коэффициенты биквада, уже поделённые на a0. */
export type Coef = { b0: number; b1: number; b2: number; a1: number; a2: number }

/**
 * Биквад по формулам RBJ - тот же фильтр, что у `BiquadFilterNode`. Полосовой -
 * с усилением 0 дБ на центре, как у узла WebAudio.
 */
export function biquad(type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q: number, rate: number): Coef {
  const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate
  const cw = Math.cos(w)
  const al = Math.sin(w) / (2 * q)
  const a0 = 1 + al
  let b0: number
  let b1: number
  let b2: number
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2
    b1 = 1 - cw
    b2 = (1 - cw) / 2
  } else if (type === 'highpass') {
    b0 = (1 + cw) / 2
    b1 = -(1 + cw)
    b2 = (1 + cw) / 2
  } else {
    b0 = al
    b1 = 0
    b2 = -al
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 }
}

/** Сколько отсчётов считать между уступками главному потоку. */
export const SLICE = 8192

/**
 * RMS, к которому приводится каждая посчитанная петля. Громкость слоя потом
 * ставится одним множителем: уровень из таблицы, делённый на это число.
 */
export const LOOP_RMS = 0.1

/**
 * Пропустить петлю через фильтр так, чтобы стык остался бесшовным.
 *
 * Фильтр с памятью, запущенный с нуля, на первых отсчётах звучит иначе, чем в
 * середине, - на стыке петли это щелчок. Поэтому память фильтра сперва
 * наполняется хвостом той же петли: для отсчёта номер 0 предыдущими оказываются
 * последние, ровно как при игре по кругу.
 */
export function* filterLoop(x: Float32Array, c: Coef, rate: number, primeSeconds = 0.3): Generator<void, void> {
  const n = x.length
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  const prime = Math.min(n, Math.floor(rate * primeSeconds))
  for (let i = n - prime; i < n; i++) {
    const v = x[i]
    const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1
    x1 = v
    y2 = y1
    y1 = y
  }
  for (let i = 0; i < n; i++) {
    const v = x[i]
    const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1
    x1 = v
    y2 = y1
    y1 = y
    x[i] = y
    if (i % SLICE === SLICE - 1) yield
  }
}

/** Среднеквадратичное значение массива - порциями. */
export function* rmsOf(x: Float32Array): Generator<void, number> {
  let s = 0
  for (let i = 0; i < x.length; i++) {
    s += x[i] * x[i]
    if (i % SLICE === SLICE - 1) yield
  }
  return Math.sqrt(s / Math.max(1, x.length))
}

/** Прибавить к `x` массив `y`, умноженный на `k`, - порциями. */
export function* mixInto(x: Float32Array, y: Float32Array, k: number): Generator<void, void> {
  for (let i = 0; i < x.length; i++) {
    x[i] += y[i] * k
    if (i % SLICE === SLICE - 1) yield
  }
}

/**
 * Довести петлю, порциями:
 *   - вычесть среднее: постоянная составляющая в петле - это щелчок на старте
 *     и потерянный запас громкости;
 *   - если попросили, мягко придавить редкие пики (`soften`): всё выше 2.5 RMS
 *     гладко гнётся к 4 RMS (12 дБ над средним). Ливень - сотни зёрен в секунду, и одно крупное
 *     поверх остальных даёт пик на 20 дБ выше среднего; в петле, которая
 *     крутится весь вечер, это щелчок, а на мастере - съеденный запас
 *     громкости. Кривая гладкая, и зерно под ней остаётся зерном;
 *   - привести к RMS `rms` (по умолчанию `LOOP_RMS`): слой потом ставит
 *     громкость одним множителем, не зная, как петля считалась.
 */
export function* polish(x: Float32Array, o: { rms?: number; soften?: boolean } = {}): Generator<void, void> {
  const n = Math.max(1, x.length)
  let sum = 0
  for (let i = 0; i < x.length; i++) {
    sum += x[i]
    if (i % SLICE === SLICE - 1) yield
  }
  const mean = sum / n
  let sq = 0
  for (let i = 0; i < x.length; i++) {
    const v = x[i] - mean
    x[i] = v
    sq += v * v
    if (i % SLICE === SLICE - 1) yield
  }
  let rms = Math.sqrt(sq / n)
  // Придавленные пики уносят часть энергии, и RMS петли опускается - а с ним
  // и потолок. Поэтому проход повторяется, пока пик не ляжет под 4 RMS того,
  // что получилось; хватает двух-трёх проходов.
  for (let pass = 0; o.soften && pass < 4; pass++) {
    const knee = 2.5 * rms
    const room = 1.5 * rms
    let peak = 0
    sq = 0
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i])
      if (a > knee) x[i] = Math.sign(x[i]) * (knee + room * Math.tanh((a - knee) / room))
      sq += x[i] * x[i]
      peak = Math.max(peak, Math.abs(x[i]))
      if (i % SLICE === SLICE - 1) yield
    }
    rms = Math.sqrt(sq / n)
    if (peak <= 4 * rms) break
  }
  const k = (o.rms ?? LOOP_RMS) / Math.max(rms, 1e-12)
  for (let i = 0; i < x.length; i++) {
    x[i] *= k
    if (i % SLICE === SLICE - 1) yield
  }
}

/** Длина таблицы шума и её маска: степень двойки, чтобы читать по кругу одним `&`. */
const NOISE_BITS = 16
export const NOISE_MASK = (1 << NOISE_BITS) - 1
let noiseTable: Float32Array | null = null

/**
 * Общая таблица белого шума, полторы секунды. Зёрна читают её со случайного
 * места, а не зовут генератор случайных чисел на каждый отсчёт: так счёт петель
 * втрое дешевле, а на слух разницы нет - зерно живёт десятки миллисекунд и
 * проходит через свой фильтр. Заводится при первом зерне, не при импорте.
 */
export function noise(): Float32Array {
  if (noiseTable) return noiseTable
  const r = rng(0x5eed)
  noiseTable = new Float32Array(NOISE_MASK + 1)
  for (let i = 0; i < noiseTable.length; i++) noiseTable[i] = r() * 2 - 1
  return noiseTable
}

/** Таблица синуса на один оборот: фаза в оборотах, 8192 деления - ошибка ниже -65 дБ. */
const SIN_BITS = 13
export const SIN_SIZE = 1 << SIN_BITS
let sinTable: Float32Array | null = null

export function sines(): Float32Array {
  if (sinTable) return sinTable
  sinTable = new Float32Array(SIN_SIZE)
  for (let i = 0; i < SIN_SIZE; i++) sinTable[i] = Math.sin((2 * Math.PI * i) / SIN_SIZE)
  return sinTable
}

/**
 * Шумовое зерно, вписанное в петлю по кругу: белый шум через полосовой
 * фильтр под огибающей «атака линейно, спад экспонентой».
 *
 * `decay` - время, за которое зерно стихает на 40 дБ; тогда на -20 дБ оно
 * опускается вдвое быстрее, и это и есть его слышимая длина. Писать по кругу
 * значит, что зерно, начатое у конца петли, договаривает в её начале, и стык
 * ничем не отличается от любого другого места.
 */
export function addGrain(
  out: Float32Array,
  at: number,
  rate: number,
  r: () => number,
  o: { freq: number; q: number; attack: number; decay: number; amp: number; type?: 'bandpass' | 'highpass' }
): void {
  const n = out.length
  const { b0, b1, b2, a1, a2 } = biquad(o.type ?? 'bandpass', o.freq, o.q, rate)
  const table = noise()
  const atk = Math.max(1, Math.round(o.attack * rate))
  const k = Math.exp(-Math.log(100) / (o.decay * rate))
  // До -60 дБ: дальше зерно тонет под соседями.
  const len = atk + Math.round(o.decay * 1.5 * rate)
  const amp = o.amp
  let p = (r() * NOISE_MASK) | 0
  let env = 0
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  let idx = at % n
  for (let j = 0; j < len; j++) {
    env = j < atk ? (j + 1) / atk : env * k
    const v = table[p++ & NOISE_MASK] * env
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = v
    y2 = y1
    y1 = y
    out[idx] += y * amp
    if (++idx === n) idx = 0
  }
}
