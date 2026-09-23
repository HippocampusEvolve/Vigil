/**
 * sound/rain.ts - текстура дождя, посчитанная заранее.
 *
 * Дождь - это зёрна: каждая капля, ударившая в лист, - короткая пачка шума
 * через полосовой фильтр. Вживую это граф из тысяч узлов в минуту, поэтому
 * петля считается в массив один раз (порциями, см. `bank.ts`) и играется по
 * кругу. Зерно, начатое у конца петли, договаривает в её начале - стыка нет.
 *
 * Два дождя:
 *   ПО ЛИСТЬЯМ  зёрна 8-20 мс (столько они держатся выше -20 дБ; стихают на
 *               40 дБ за 15-40 мс), центр полосы 800-3000 Гц, Q 2-5, атака
 *               1-2 мс; 120 зёрен в секунду на канал - полная сила ливня.
 *               Под ними шипение на 20 дБ тише зёрен. Редкие крупные зёрна
 *               мягко придавлены: пик петли не выше 12 дБ над её RMS.
 *   ПО БЕТОНУ   те же зёрна короче (2-6 мс) и выше (2-6 кГц), атака меньше
 *               1 мс, снизу срез 1 кГц; в лужах у стен ещё и мелкие капли со
 *               звоном.
 *
 * Каналы считаются порознь и разной длины: левая и правая петли расходятся и
 * сходятся снова только через десятки минут, и повтор не слышен.
 */

import { addGrain, between, biquad, filterLoop, logBetween, mixInto, polish, rmsOf, rng, SLICE, type Samples } from './dsp'
import { addDrop, dropRecipe } from './water'

/** Длины петель по каналам, с. Разные нарочно, см. шапку. */
export const RAIN_SECONDS = { leaves: [6.1, 7.3], concrete: [4.3, 5.1] } as const

export function* bakeLeaves(rate: number, channel: 0 | 1): Generator<void, Samples> {
  const seconds = RAIN_SECONDS.leaves[channel]
  const r = rng(101 + channel * 17)
  const n = Math.round(seconds * rate)
  const grains = new Float32Array(n)
  const perSecond = 120
  let t = 0
  let k = 0
  for (;;) {
    t += -Math.log(1 - r()) / perSecond
    if (t >= seconds) break
    const freq = logBetween(r, 800, 3000)
    const q = between(r, 2, 5)
    // Капель мелких много, крупных мало. Узкая низкая полоса пропускает меньше
    // энергии шума - её зерно чуть подтянуто, чтобы низ листвы не пропал.
    const size = 0.15 + 0.85 * Math.pow(r(), 3)
    addGrain(grains, Math.round(t * rate), rate, r, {
      freq,
      q,
      attack: between(r, 0.001, 0.002),
      decay: between(r, 0.015, 0.04),
      amp: size * Math.pow((q * 1000) / freq, 0.25),
    })
    if (++k % 4 === 0) yield
  }
  const hiss = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    hiss[i] = r() * 2 - 1
    if (i % SLICE === SLICE - 1) yield
  }
  yield* filterLoop(hiss, biquad('highpass', 400, 0.7, rate), rate)
  yield* filterLoop(hiss, biquad('lowpass', 6000, 0.7, rate), rate)
  const top = yield* rmsOf(grains)
  const under = yield* rmsOf(hiss)
  yield* mixInto(grains, hiss, (top * 0.1) / Math.max(under, 1e-12))
  yield* polish(grains, { soften: true })
  return grains
}

export function* bakeConcrete(rate: number, channel: 0 | 1): Generator<void, Samples> {
  const seconds = RAIN_SECONDS.concrete[channel]
  const r = rng(211 + channel * 23)
  const n = Math.round(seconds * rate)
  const d = new Float32Array(n)
  const perSecond = 180
  let t = 0
  let k = 0
  for (;;) {
    t += -Math.log(1 - r()) / perSecond
    if (t >= seconds) break
    addGrain(d, Math.round(t * rate), rate, r, {
      freq: logBetween(r, 2000, 6000),
      q: between(r, 1, 2.5),
      attack: between(r, 0.0001, 0.0008),
      decay: between(r, 0.004, 0.012),
      amp: 0.2 + 0.8 * Math.pow(r(), 2),
    })
    if (++k % 8 === 0) yield
  }
  // Лужи у стен: мелкие капли, выше и короче обычной.
  t = 0
  for (;;) {
    t += -Math.log(1 - r()) / 14
    if (t >= seconds) break
    const o = dropRecipe(r, between(r, 1.5, 2.6))
    o.sweep *= 0.5
    o.amp *= between(r, 0.15, 0.4)
    addDrop(d, Math.round(t * rate), rate, r, o)
    if (++k % 8 === 0) yield
  }
  yield* filterLoop(d, biquad('highpass', 1000, 0.7, rate), rate)
  yield* polish(d, { soften: true })
  return d
}
