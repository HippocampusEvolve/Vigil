/**
 * sound/roof.ts - дробь дождя по кровле изнутри, посчитанная заранее.
 *
 * Снаружи ливень по бетону шипит (`rain.ts`); изнутри бетон отвечает сам.
 * Тот же генератор капель - короткие зёрна, как у дождя по бетону, - бьёт не в
 * ухо, а в свод, и свод звенит своими модами: четыре резонанса с
 * негармоничными отношениями, спад 150-300 мс. Потом всё срезается сверху на
 * 4 кГц - верх бетон не пропускает. Под дробью розовый шум через срез 800 Гц:
 * гул ливня по всей крыше разом.
 *
 * Изнутри дождь темнее, чем снаружи: центроид дождя на поляне не меньше двух
 * центроидов дроби изнутри.
 *
 * Петля одна на две кровли: плоская плита блока звенит выше свода ангара, и
 * её дробь - та же петля, сыгранная быстрее (`indoor.ts`). Каналы - две
 * петли разной длины, как у дождя.
 */

import { addGrain, between, biquad, filterLoop, logBetween, mixInto, polish, rmsOf, rng, SLICE, type Coef, type Samples } from './dsp'

/** Длины петель по каналам, с. */
export const ROOF_SECONDS = [3.3, 3.9] as const

/** Моды свода: [Гц, сила, спад до -60 дБ, с]. Отношения 1 : 1.59 : 2.51 : 3.92 - не кратные. */
export const VAULT_MODES: ReadonlyArray<readonly [number, number, number]> = [
  [210, 1, 0.3],
  [333, 0.8, 0.25],
  [527, 0.6, 0.2],
  [823, 0.45, 0.15],
]

/** Капель по кровле в секунду: ливень. */
const DROPS = 170

/** Резонатор: два полюса на частоте `f` со спадом `t60`, для прогона по петле. */
function mode(f: number, t60: number, rate: number): Coef {
  const rho = Math.exp(-6.9078 / (t60 * rate))
  const w = (2 * Math.PI * f) / rate
  return { b0: 1 - rho, b1: 0, b2: 0, a1: -2 * rho * Math.cos(w), a2: rho * rho }
}

/**
 * Розовый шум по кругу (фильтр Келлета поверх белого): память фильтра сперва
 * наполняется хвостом той же петли, как в `filterLoop`, - стыка нет.
 */
function* pink(n: number, rate: number, r: () => number): Generator<void, Samples> {
  const white = new Float32Array(n)
  for (let i = 0; i < n; i++) white[i] = r() * 2 - 1
  const out = new Float32Array(n)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  const prime = Math.min(n, Math.round(rate * 0.5))
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? n - prime : 0
    for (let i = from; i < n; i++) {
      const w = white[i]
      b0 = 0.99765 * b0 + w * 0.099046
      b1 = 0.963 * b1 + w * 0.2965164
      b2 = 0.57 * b2 + w * 1.0526913
      if (pass === 1) out[i] = b0 + b1 + b2 + w * 0.1848
      if (i % SLICE === SLICE - 1) yield
    }
  }
  return out
}

export function* bakeRoof(rate: number, channel: 0 | 1): Generator<void, Samples> {
  const seconds = ROOF_SECONDS[channel]
  const r = rng(307 + channel * 29)
  const n = Math.round(seconds * rate)
  const hits = new Float32Array(n)
  let t = 0
  let k = 0
  for (;;) {
    t += -Math.log(1 - r()) / DROPS
    if (t >= seconds) break
    addGrain(hits, Math.round(t * rate), rate, r, {
      freq: logBetween(r, 700, 2500),
      q: 0.7,
      attack: 0.0003,
      decay: between(r, 0.002, 0.006),
      amp: 0.2 + 0.8 * Math.pow(r(), 3),
    })
    if (++k % 8 === 0) yield
  }
  const drum = new Float32Array(n)
  const one = new Float32Array(n)
  for (const [f, amp, t60] of VAULT_MODES) {
    one.set(hits)
    // Память резонатора наполняется хвостом петли длиннее его спада: стыка нет.
    yield* filterLoop(one, mode(f * between(r, 0.99, 1.01), t60, rate), rate, t60 * 1.5)
    const level = yield* rmsOf(one)
    yield* mixInto(drum, one, amp / Math.max(level, 1e-12))
  }
  // Удар капли сам по себе - тонкий щелчок поверх звона.
  const top = yield* rmsOf(drum)
  const tickLevel = yield* rmsOf(hits)
  yield* mixInto(drum, hits, (top * 0.2) / Math.max(tickLevel, 1e-12))
  yield* filterLoop(drum, biquad('lowpass', 4000, 0.7, rate), rate)
  // Гул ливня по всей крыше: розовый шум под срезом 800 Гц, на 4 дБ тише дроби.
  const bed = yield* pink(n, rate, r)
  yield* filterLoop(bed, biquad('lowpass', 800, 0.7, rate), rate)
  yield* filterLoop(bed, biquad('highpass', 30, 0.7, rate), rate)
  const drumLevel = yield* rmsOf(drum)
  const bedLevel = yield* rmsOf(bed)
  yield* mixInto(drum, bed, (drumLevel * 0.63) / Math.max(bedLevel, 1e-12))
  yield* polish(drum, { soften: true })
  return drum
}
