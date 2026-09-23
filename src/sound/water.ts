/**
 * sound/water.ts - вода, посчитанная заранее: капля, завеса капель с навеса,
 * ручей.
 *
 * Капля звенит пузырьком: когда она падает в воду, под поверхностью на миг
 * остаётся пузырёк воздуха, и он звенит синусом, высота которого сползает
 * (здесь от 1200 к 400 Гц за 30-60 мс). Перед звоном - щелчок удара, 2-5 мс
 * шума. Атака мгновенная, не больше 2 мс, а яркость падает за первые 50 мс.
 *
 * Та же капля с другими числами - это и дождь в луже у поста, и завеса с
 * кромки навеса, и (с высотой, ползущей вверх) пузыри ручья. Один рецепт на
 * всю воду: ухо узнаёт в них одно вещество.
 */

import {
  addGrain,
  between,
  biquad,
  filterLoop,
  logBetween,
  mixInto,
  noise,
  NOISE_MASK,
  polish,
  rmsOf,
  rng,
  SIN_SIZE,
  sines,
  SLICE,
  type Samples,
} from './dsp'

export type Drop = {
  /** Высота в начале и в конце сползания, Гц. */
  f0: number
  f1: number
  /** За сколько сползает высота, с. */
  sweep: number
  /** Сила звона. */
  amp: number
  /** Щелчок удара: длина, с, и сила. */
  click: number
  clickAmp: number
}

/**
 * Вписать каплю в массив с отсчёта `at` (по кругу, если массив - петля).
 * Звон гаснет на 40 дБ за полторы длины сползания.
 */
export function addDrop(out: Float32Array, at: number, rate: number, r: () => number, o: Drop): void {
  const n = out.length
  const sin = sines()
  const table = noise()
  const sweepN = Math.max(1, Math.round(o.sweep * rate))
  const ringN = o.sweep * 1.5 * rate
  const len = Math.round(ringN * 1.5)
  const atk = Math.max(1, Math.round(0.0004 * rate))
  const k = Math.exp(-Math.log(100) / ringN)
  const glide = Math.pow(o.f1 / o.f0, 1 / sweepN)
  const clickN = Math.max(1, Math.round(o.click * rate))
  const clickAmp = 0.5 * o.clickAmp
  // Фаза - в оборотах, шаг фазы - частота в оборотах на отсчёт.
  let step = o.f0 / rate
  let ph = 0
  let env = 0
  let prev = 0
  let p = (r() * NOISE_MASK) | 0
  let idx = at % n
  for (let j = 0; j < len; j++) {
    env = j < atk ? (j + 1) / atk : env * k
    let v = sin[(ph * SIN_SIZE) | 0] * env * o.amp
    if (j < clickN) {
      // Щелчок - разность соседних отсчётов шума: верх открыт, низа нет.
      const w = table[p++ & NOISE_MASK]
      v += (w - prev) * clickAmp * (1 - j / clickN)
      prev = w
    }
    out[idx] += v
    if (++idx === n) idx = 0
    ph += step
    if (ph >= 1) ph -= 1
    if (j < sweepN) step *= glide
  }
}

/** Числа одной капли по рецепту: 1200 к 400 Гц за 30-60 мс, щелчок 2-5 мс. Чуть врозь каждый раз. */
export function dropRecipe(r: () => number, scale = 1): Drop {
  const pitch = between(r, 0.85, 1.2) * scale
  return {
    f0: 1200 * pitch,
    f1: 400 * pitch * between(r, 0.9, 1.1),
    sweep: between(r, 0.03, 0.06),
    amp: between(r, 0.6, 1),
    click: between(r, 0.002, 0.005),
    clickAmp: between(r, 0.5, 0.9),
  }
}

/**
 * Набор отдельных капель для разовых звуков: капля с листа, брызги всплеска.
 * Каждая - короткий моно-массив; живьём играется случайная из набора, с чуть
 * другой скоростью, и два раза подряд одинаковой капли не выходит.
 */
export function* bakeDrops(rate: number, count = 12, seed = 31): Generator<void, Samples[]> {
  const r = rng(seed)
  const out: Samples[] = []
  for (let i = 0; i < count; i++) {
    const o = dropRecipe(r)
    const d = new Float32Array(Math.round(o.sweep * 1.5 * 1.5 * rate) + 8)
    // Не по кругу: массив длиннее капли, конец её в начало не заворачивает.
    addDrop(d, 0, rate, r, o)
    let peak = 0
    for (let j = 0; j < d.length; j++) peak = Math.max(peak, Math.abs(d[j]))
    for (let j = 0; j < d.length; j++) d[j] /= peak
    out.push(d)
    yield
  }
  return out
}

/**
 * Завеса с кромки навеса: вода собирается на плите и срывается с передней
 * кромки частыми каплями. Половина бьёт в бетон отмостки (короткий шлепок,
 * верх открыт), половина - в лужи под кромкой (капля со звоном).
 */
export function* bakeCurtain(rate: number, seconds = 6.7, seed = 41): Generator<void, Samples> {
  const r = rng(seed)
  const n = Math.round(seconds * rate)
  const d = new Float32Array(n)
  const perSecond = 45
  let t = 0
  let k = 0
  for (;;) {
    t += -Math.log(1 - r()) / perSecond
    if (t >= seconds) break
    const at = Math.round(t * rate)
    if (r() < 0.55) {
      addGrain(d, at, rate, r, {
        freq: logBetween(r, 1500, 4500),
        q: between(r, 0.9, 1.5),
        attack: 0.0002,
        decay: between(r, 0.005, 0.012),
        amp: between(r, 0.4, 1),
      })
    } else {
      const o = dropRecipe(r, between(r, 0.8, 1.3))
      o.amp *= between(r, 0.3, 0.8)
      addDrop(d, at, rate, r, o)
    }
    if (++k % 6 === 0) yield
  }
  yield* polish(d)
  return d
}

/**
 * Ручей: журчание - это пузыри, лопающиеся у поверхности. Пузырь звенит, как
 * капля, но высота его ползёт вверх: он поднимается и сжимается. Под пузырями
 * глухой шум потока.
 */
export function* bakeStream(rate: number, seconds = 7.7, seed = 53): Generator<void, Samples> {
  const r = rng(seed)
  const n = Math.round(seconds * rate)
  const bubbles = new Float32Array(n)
  const perSecond = 110
  let t = 0
  let k = 0
  for (;;) {
    t += -Math.log(1 - r()) / perSecond
    if (t >= seconds) break
    const f0 = logBetween(r, 350, 1300)
    addDrop(bubbles, Math.round(t * rate), rate, r, {
      f0,
      f1: f0 * between(r, 1.3, 1.8),
      sweep: between(r, 0.008, 0.025),
      amp: Math.pow(r(), 2) * 0.9 + 0.1,
      click: 0.001,
      clickAmp: 0,
    })
    if (++k % 8 === 0) yield
  }
  // Поток: шум, срезанный сверху и снизу, на 10 дБ тише пузырей.
  const bed = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    bed[i] = r() * 2 - 1
    if (i % SLICE === SLICE - 1) yield
  }
  yield* filterLoop(bed, biquad('lowpass', 900, 0.7, rate), rate)
  yield* filterLoop(bed, biquad('highpass', 120, 0.7, rate), rate)
  const top = yield* rmsOf(bubbles)
  const under = yield* rmsOf(bed)
  yield* mixInto(bubbles, bed, (top * 0.316) / Math.max(under, 1e-12))
  yield* polish(bubbles)
  return bubbles
}
