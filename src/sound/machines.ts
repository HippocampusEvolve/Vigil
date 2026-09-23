/**
 * sound/machines.ts - ровные звуки нутра, посчитанные заранее петлями.
 *
 *   ГУЛ ТРУБКИ   дроссель гудит от сети 50 Гц: основа 100 Гц и гармоники 200,
 *                300, 400 со спадом, лёгкое насыщение. У каждой гармоники своя
 *                расстройка на доли герца - форма волны медленно плывёт. Та же
 *                формула, что у лампы входа (`outdoor.ts`), только петлёй: трубок
 *                пять, и живых генераторов на каждую было бы слишком много.
 *                Своя дрожь и расстройка у каждой трубки - живьём, скоростью
 *                петли (`indoor.ts`). Главный пик 90-110 Гц; пик 200 Гц не ниже
 *                главного на 12 дБ.
 *   ФИТОЛАМПЫ    выше и тоньше: основы 100 Гц нет, гул держится на 200 Гц и
 *                чётных гармониках выше.
 *   СТАРТЁР      зуд старого стартёра: узкий шум 2-4 кГц пачками на каждой
 *                полуволне сети, с провалами 10-40 мс.
 *   ЧАСЫ         тик и так через секунду: щелчок спуска и два коротких звона
 *                корпуса; «так» чуть ниже. Петля в две секунды - ровно два удара.
 *   НАСОСЫ       мотор 25 оборотов в секунду с гудением сети 100 Гц и тонким
 *                воем крыльчатки; вода в трубах - коричневый шум через полосу
 *                около 420 Гц, накатами на каждый ход.
 *
 * Петли бесшовны: всё периодическое укладывается в длину петли целым числом
 * периодов, всё фильтрованное считается с памятью, наполненной хвостом.
 */

import { addGrain, between, biquad, filterLoop, logBetween, mixInto, polish, rmsOf, rng, SIN_SIZE, sines, SLICE, type Samples } from './dsp'
import { ringInto, toPeak } from './strike'

/** Гармоники гула трубки: [множитель к 100 Гц, сила]. */
export const HUM: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [2, 0.5],
  [3, 0.28],
  [4, 0.16],
]

/** Гармоники фитоламп: основы нет, верх гуще. */
export const PHYTO: ReadonlyArray<readonly [number, number]> = [
  [2, 1],
  [3, 0.3],
  [4, 0.55],
  [6, 0.3],
  [8, 0.18],
]

/** Длина петли гула, с: 100 Гц и расстройки по 0.5 Гц укладываются в неё целыми периодами. */
export const HUM_SECONDS = 2

export function* bakeHum(rate: number, parts: ReadonlyArray<readonly [number, number]>, seed = 11): Generator<void, Samples> {
  const r = rng(seed)
  const n = HUM_SECONDS * rate
  const d = new Float32Array(n)
  const sin = sines()
  for (const [k, a] of parts) {
    // Расстройка кратна 1 / HUM_SECONDS: гармоника остаётся периодической в петле.
    const f = 100 * k + (Math.floor(r() * 3) - 1) / HUM_SECONDS
    const step = f / rate
    let ph = r()
    for (let i = 0; i < n; i++) {
      d[i] += sin[(ph * SIN_SIZE) | 0] * a * 0.5
      ph += step
      ph -= Math.floor(ph)
      if (i % SLICE === SLICE - 1) yield
    }
  }
  // Лёгкое насыщение: наклон в нуле - единица, гнутся только гребни.
  for (let i = 0; i < n; i++) {
    d[i] = Math.tanh(1.4 * d[i]) / 1.4
    if (i % SLICE === SLICE - 1) yield
  }
  yield* polish(d)
  return d
}

/** Зуд стартёра: пачки на каждой полуволне сети, провалы. */
export function* bakeStarter(rate: number, seconds = 1.5, seed = 13): Generator<void, Samples> {
  const r = rng(seed)
  const n = Math.round(seconds * rate)
  const d = new Float32Array(n)
  const bursts = Math.round(seconds * 100)
  let gapUntil = -1
  for (let b = 0; b < bursts; b++) {
    const t = b / 100
    if (t < gapUntil) continue
    if (r() < 0.05) {
      gapUntil = t + between(r, 0.01, 0.04)
      continue
    }
    addGrain(d, Math.round((t + between(r, -0.0003, 0.0003)) * rate + n) % n, rate, r, {
      freq: logBetween(r, 2000, 4000),
      q: 4,
      attack: 0.0002,
      decay: between(r, 0.0015, 0.003),
      amp: between(r, 0.5, 1),
    })
    if (b % 16 === 0) yield
  }
  yield* polish(d)
  return d
}

/**
 * Часы: тик в 0.05 с и так в 1.05 с. Петля приведена к пику 1, а не к RMS:
 * у тиканья уровень - пик удара.
 */
export function* bakeClock(rate: number, seed = 17): Generator<void, Samples> {
  const r = rng(seed)
  const n = 2 * rate
  const d = new Float32Array(n)
  for (const [at, pitch, amp] of [
    [0.05, 1, 1],
    [1.05, 0.9, 0.85],
  ] as const) {
    const i = Math.round(at * rate)
    addGrain(d, i, rate, r, { freq: 3500 * pitch, q: 1.5, attack: 0.0001, decay: 0.003, amp })
    ringInto(d, i, rate, { freq: 1650 * pitch, t60: 0.04, amp: amp * 0.5 })
    ringInto(d, i, rate, { freq: 4100 * pitch, t60: 0.02, amp: amp * 0.3 })
  }
  yield
  toPeak(d)
  return d
}

/** Насосы: 4 с - сто оборотов мотора и пять ходов воды. */
export const PUMP = { seconds: 4, rpsHz: 25, strokes: 5 } as const

export function* bakePump(rate: number, seed = 19): Generator<void, Samples> {
  const r = rng(seed)
  const n = PUMP.seconds * rate
  const motor = new Float32Array(n)
  const sin = sines()
  // Гармоники оборота: 25, 50, 100 (сеть), 150, 200 и вой крыльчатки 575 Гц.
  for (const [k, a] of [
    [1, 0.25],
    [2, 0.5],
    [4, 1],
    [6, 0.3],
    [8, 0.22],
    [23, 0.06],
  ] as const) {
    const step = (PUMP.rpsHz * k) / rate
    let ph = r()
    for (let i = 0; i < n; i++) {
      motor[i] += sin[(ph * SIN_SIZE) | 0] * a
      ph += step
      ph -= Math.floor(ph)
      if (i % SLICE === SLICE - 1) yield
    }
  }
  // Вода: белый шум, проинтегрированный с утечкой (коричневый), через полосу.
  const water = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    water[i] = r() * 2 - 1
    if (i % SLICE === SLICE - 1) yield
  }
  yield* filterLoop(water, { b0: 0.0026, b1: 0, b2: 0, a1: -0.9974, a2: 0 }, rate, 1)
  yield* filterLoop(water, biquad('bandpass', 420, 0.8, rate), rate)
  // Накаты: на каждый ход вода быстро поднимается и медленно опадает.
  const period = n / PUMP.strokes
  for (let i = 0; i < n; i++) {
    const t = (i % period) / rate
    const surge = t < 0.12 ? t / 0.12 : Math.exp(-(t - 0.12) / 0.25)
    water[i] *= 0.35 + 0.65 * surge
    if (i % SLICE === SLICE - 1) yield
  }
  const m = yield* rmsOf(motor)
  const w = yield* rmsOf(water)
  yield* mixInto(motor, water, (m * 0.7) / Math.max(w, 1e-12))
  yield* polish(motor)
  return motor
}
