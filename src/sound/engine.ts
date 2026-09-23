/**
 * sound/engine.ts - генератор поста, посчитанный заранее.
 *
 * Генератор бубнит низко: основа - пила 25 Гц (1500 оборотов в минуту), и
 * слышна она гармониками 50-100 Гц, которые доходят и до телефонного динамика.
 * На каждую вспышку (каждый второй оборот, двигатель четырёхтактный) - пачка
 * хлопков, выдох шума 200-2000 Гц из выхлопа и слабый дребезг кожуха.
 * Центроид ниже 250 Гц, и не меньше 40 % энергии ниже 120 Гц.
 *
 * Петля - ровно сто оборотов, поэтому стык попадает на границу оборота и не
 * слышен. Медленная дрожь хода (0.1-2 Гц) в петлю не зашита: её делает граф,
 * качая скорость проигрывания (`outdoor.ts`), - так она не повторяется с
 * петлёй.
 */

import { addGrain, between, biquad, filterLoop, logBetween, mixInto, polish, rmsOf, rng, SLICE, type Samples } from './dsp'

/** Частота вращения, Гц, и длина петли в оборотах. */
export const ENGINE = { hz: 25, cycles: 100 } as const

/** Громкость частей относительно пилы, дБ. */
const PARTS = { pops: -13, exhaust: -24, rattle: -32 } as const

export function* bakeEngine(rate: number, seed = 61): Generator<void, Samples> {
  const r = rng(seed)
  const period = Math.round(rate / ENGINE.hz)
  const n = period * ENGINE.cycles
  const saw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    saw[i] = (2 * (i % period)) / period - 1
    if (i % SLICE === SLICE - 1) yield
  }
  // Пила срезается сверху: основа и гармоники до ~150 Гц, выше - только следы.
  yield* filterLoop(saw, biquad('lowpass', 170, 0.8, rate), rate)
  yield* filterLoop(saw, biquad('lowpass', 400, 0.7, rate), rate)

  const pops = new Float32Array(n)
  const exhaust = new Float32Array(n)
  const rattle = new Float32Array(n)
  const ms = rate / 1000
  for (let c = 0; c < ENGINE.cycles; c += 2) {
    const at = c * period + Math.round(period * 0.28 + between(r, -0.5, 0.5) * ms)
    // Вспышки неровные: изредка слабая, изредка с оттяжкой.
    const strength = r() < 0.08 ? between(r, 0.5, 0.7) : between(r, 0.85, 1.15)
    const count = r() < 0.5 ? 2 : 3
    let off = 0
    for (let p = 0; p < count; p++) {
      addGrain(pops, at + off, rate, r, {
        freq: logBetween(r, 160, 320),
        q: 1.2,
        attack: 0.0005,
        decay: between(r, 0.02, 0.035),
        amp: strength * (p === 0 ? 1 : 0.45),
      })
      off += Math.round(between(r, 3, 6) * ms)
    }
    addGrain(exhaust, at, rate, r, { freq: 700, q: 0.45, attack: 0.002, decay: 0.07, amp: strength })
    addGrain(rattle, at + Math.round(between(r, 2, 8) * ms), rate, r, {
      freq: logBetween(r, 1600, 2600),
      q: 12,
      attack: 0.0003,
      decay: 0.02,
      amp: between(r, 0.3, 1),
    })
    yield
  }
  const base = yield* rmsOf(saw)
  for (const [x, dbRel] of [
    [pops, PARTS.pops],
    [exhaust, PARTS.exhaust],
    [rattle, PARTS.rattle],
  ] as const) {
    const own = yield* rmsOf(x)
    yield* mixInto(saw, x, (base * Math.pow(10, dbRel / 20)) / Math.max(own, 1e-12))
  }
  // Кожух и стены комнаты верх не пропускают: всё, что выше 1.2 кГц, -
  // только юбки фильтров хлопков, и их срезаем круто, иначе шипящая дымка по
  // всей полосе тянет яркость вверх, хотя слышна едва.
  yield* filterLoop(saw, biquad('lowpass', 1200, 0.7, rate), rate)
  yield* filterLoop(saw, biquad('lowpass', 1200, 0.7, rate), rate)
  yield* polish(saw)
  return saw
}
