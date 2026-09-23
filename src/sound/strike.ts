/**
 * sound/strike.ts - разовые звуки нутра, посчитанные в массив.
 *
 * Скрип, лязг, удар створки, шаг по стальному маршу, стон корпуса собираются
 * не графом из десятков узлов на каждый раз, а арифметикой: несколько
 * затухающих синусов и шумовых зёрен в короткий массив. Так дешевле (скрип -
 * это сотня щелчков, и каждый звенит тремя резонансами), и пик у готового
 * звука известен точно: массив приводится к пику 1, и уровень из `LEVEL` -
 * это и есть пик на выходе.
 *
 * Счёт короткий (скрип в две секунды - единицы миллисекунд), поэтому идёт
 * прямо в момент события; шаги по маршу и капли в ведро считаются заранее
 * наборами (`bank.ts`), как капли поляны.
 *
 * Что как звучит:
 *   СКРИП ДВЕРИ   цепочка «срывов» петли: каждый срыв - щелчок, звенящий в трёх
 *                 узких резонансах 800-2100 Гц (добротность около 18, спад
 *                 20-60 мс). Створка разгоняется и тормозит, и за её
 *                 скоростью идут частота срывов (14-55 в секунду) и высота
 *                 резонансов. Дверь скрипит долго: не короче 600 мс в пределах
 *                 30 дБ от пика.
 *   ЛЯЗГ ЗАМКА    два щелчка через 30-80 мс (шум 3-6 кГц) и звон засова -
 *                 пять негармоничных мод от 500 Гц, спад до -30 дБ за 300-900
 *                 мс. Атака мгновенная: не больше 2 мс.
 *   УДАР СТВОРКИ  глухой удар о коробку (шум под срезом 900 Гц и низкий тон
 *                 с падающей высотой), звон полотна и через 25-40 мс щелчок
 *                 защёлки.
 *   ШАГ ПО МАРШУ  щелчок и три моды 800-3000 Гц со спадом 60-150 мс; через
 *                 10-20 мс дребезг незакреплённой проступи.
 *   СТОН КОРПУСА  3-5 мод 40-200 Гц с долгим спадом 2-5 с, высота чуть плывёт;
 *                 вступает мягко, как нагрузка, а не удар.
 *   СТАРТЁР       щелчок на провале света (шум 2-4 кГц, 2 мс) и «тинк»
 *                 зажигания на возврате - звон 3-5 кГц на 5-15 мс.
 */

import type { DoorId } from '../world/zones'
import { addGrain, between, logBetween, rng, SIN_SIZE, sines, type Samples } from './dsp'

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

/**
 * Затухающий синус в массив с отсчёта `at`: спад на 60 дБ за `t60`, мягкое
 * вступление `attack` (по умолчанию - сразу, с нулевой фазы: ступеньки нет),
 * высота может плыть на долю `drift` к концу.
 */
export function ringInto(
  out: Float32Array,
  at: number,
  rate: number,
  o: { freq: number; t60: number; amp: number; attack?: number; drift?: number; phase?: number }
): void {
  const sin = sines()
  const k = Math.exp(-6.9078 / (o.t60 * rate))
  // До -80 дБ: дальше звон тонет под всем остальным.
  const len = Math.min(out.length - at, Math.round(o.t60 * 1.34 * rate))
  const atk = Math.max(1, Math.round((o.attack ?? 0) * rate))
  const drift = o.drift ?? 0
  let env = o.amp
  let ph = o.phase ?? 0
  for (let j = 0; j < len; j++) {
    const rise = j < atk ? 0.5 - 0.5 * Math.cos((Math.PI * j) / atk) : 1
    out[at + j] += sin[(ph * SIN_SIZE) | 0] * env * rise
    ph += (o.freq * (1 + (drift * j) / len)) / rate
    ph -= Math.floor(ph)
    env *= k
  }
}

/** Убрать постоянную составляющую и привести пик к единице. */
export function toPeak(d: Float32Array): void {
  let mean = 0
  for (let i = 0; i < d.length; i++) mean += d[i]
  mean /= Math.max(1, d.length)
  let peak = 0
  for (let i = 0; i < d.length; i++) {
    d[i] -= mean
    peak = Math.max(peak, Math.abs(d[i]))
  }
  if (peak > 0) for (let i = 0; i < d.length; i++) d[i] /= peak
}

/** Голос двери: высота звона, сила звона полотна, вес удара. */
export type DoorVoice = { pitch: number; ring: number; weight: number }

/**
 * Стальные двери блока звенят, дверь медпункта глуше, крышка люка ниже и
 * звонче, утеплённая дверь холодной - почти без звона, тяжёлая.
 */
export const DOOR_VOICE: Record<DoorId, DoorVoice> = {
  entry: { pitch: 1, ring: 1, weight: 1 },
  inner: { pitch: 1.08, ring: 0.9, weight: 0.9 },
  med: { pitch: 1.25, ring: 0.45, weight: 0.7 },
  gen: { pitch: 0.94, ring: 1, weight: 1 },
  hatch: { pitch: 0.78, ring: 1.2, weight: 1.25 },
  cold: { pitch: 0.7, ring: 0.3, weight: 1.35 },
}

// --- Скрип ---------------------------------------------------------------------------

/**
 * Скрип петли. `swing` - на сколько радиан обычно поворачивается створка;
 * `fast` - скорость, на которой скрип выходит на самые частые срывы и самую
 * высокую ноту; `clicks` - срывы в секунду от медленной створки до быстрой.
 */
export const CREAK = {
  swing: 1.4,
  fast: 1.5,
  clicks: [14, 55],
  modes: [
    [820, 1],
    [1290, 0.7],
    [2050, 0.45],
  ],
  q: 18,
  /** Длина скрипа, с: створка проходит `swing` со своей скоростью, но не короче и не длиннее этого. */
  length: [0.7, 2.6],
} as const

/**
 * Скрип створки со скоростью `speed` рад/с. Скорость внутри звука не ровная:
 * створка разгоняется и тормозит, и за ней идут частота срывов и высота.
 * Закрывается дверь чуть ниже, чем открывается: петля нагружена иначе.
 */
export function renderCreak(rate: number, speed: number, closing: boolean, voice: DoorVoice, seed = Math.random() * 1e9): Samples {
  const r = rng(seed >>> 0)
  const v0 = clamp(speed, 0.2, 4)
  const T = clamp(CREAK.swing / v0, CREAK.length[0], CREAK.length[1])
  const n = Math.round((T + 0.2) * rate)
  const exc = new Float32Array(n)
  // Сколько от «быстрой» скорости в момент t: 0..1.
  const pace = (t: number): number => Math.min(1, (Math.pow(Math.sin((Math.PI * clamp(t, 0, T)) / T), 0.6) * v0) / CREAK.fast)
  let t = 0.01
  while (t < T) {
    const k = pace(t)
    const i = Math.round(t * rate)
    exc[i] += (0.3 + 0.7 * k) * (r() < 0.5 ? -1 : 1) * between(r, 0.75, 1.15)
    const hz = CREAK.clicks[0] + (CREAK.clicks[1] - CREAK.clicks[0]) * k
    t += between(r, 0.75, 1.25) / hz
  }
  const out = new Float32Array(n)
  // Щелчок срыва сам по себе тоже слышен - чуть-чуть, иначе скрип звучит свистом.
  for (let i = 0; i < n; i++) out[i] = exc[i] * 0.04
  const lower = (closing ? 0.92 : 1) * voice.pitch
  for (const [base, amp] of CREAK.modes) {
    // Резонатор с плывущей высотой: коэффициенты пересчитываются раз в 32 отсчёта.
    let y1 = 0
    let y2 = 0
    let a1 = 0
    let a2 = 0
    let g = 0
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) {
        const f = base * lower * (0.85 + 0.3 * pace(i / rate))
        const t60 = (6.9078 * CREAK.q) / (Math.PI * f)
        const rho = Math.exp(-6.9078 / (t60 * rate))
        const w = (2 * Math.PI * f) / rate
        a1 = -2 * rho * Math.cos(w)
        a2 = rho * rho
        g = (1 - rho) * amp
      }
      const y = g * exc[i] - a1 * y1 - a2 * y2
      y2 = y1
      y1 = y
      out[i] += y
    }
  }
  toPeak(out)
  return out
}

// --- Замок и удар ----------------------------------------------------------------------

/** Моды засова: отношения к основной, намеренно не кратные; сила и спад до -60 дБ. */
const BOLT = {
  base: 520,
  modes: [
    [1, 1, 0.95],
    [1.43, 0.75, 0.8],
    [2.31, 0.55, 0.62],
    [2.87, 0.4, 0.5],
    [3.61, 0.3, 0.4],
  ],
  /** Звон засова относительно щелчка. */
  ring: 0.35,
} as const

/** Щелчок металла о металл: шум 3-6 кГц, гаснет за единицы миллисекунд. */
function tick(out: Float32Array, at: number, rate: number, r: () => number, amp: number): void {
  addGrain(out, at, rate, r, { type: 'highpass', freq: 3000, q: 0.7, attack: 0.0002, decay: between(r, 0.003, 0.005), amp })
  addGrain(out, at, rate, r, { freq: logBetween(r, 3800, 5500), q: 1.5, attack: 0.0002, decay: 0.004, amp: amp * 0.6 })
}

/** Лязг замка: два щелчка и звон засова. */
export function renderLock(rate: number, voice: DoorVoice, seed = Math.random() * 1e9): Samples {
  const r = rng(seed >>> 0)
  const n = Math.round(1.4 * rate)
  const out = new Float32Array(n)
  const t0 = Math.round(0.004 * rate)
  const t1 = t0 + Math.round(between(r, 0.03, 0.08) * rate)
  tick(out, t0, rate, r, 1)
  tick(out, t1, rate, r, 0.7)
  const f0 = BOLT.base * voice.pitch * between(r, 0.95, 1.05)
  for (const [ratio, amp, t60] of BOLT.modes) {
    const a = BOLT.ring * amp * Math.min(1.3, voice.ring)
    ringInto(out, t0, rate, { freq: f0 * ratio, t60, amp: a })
    ringInto(out, t1, rate, { freq: f0 * ratio, t60: t60 * 0.8, amp: a * 0.5, phase: r() })
  }
  toPeak(out)
  return out
}

/** Удар створки о коробку: глухой удар, звон полотна, щелчок защёлки. */
export function renderSlam(rate: number, voice: DoorVoice, seed = Math.random() * 1e9): Samples {
  const r = rng(seed >>> 0)
  const n = Math.round(1.0 * rate)
  const out = new Float32Array(n)
  const t0 = Math.round(0.004 * rate)
  addGrain(out, t0, rate, r, { type: 'lowpass', freq: 900, q: 0.7, attack: 0.0005, decay: 0.03, amp: 1.6 })
  ringInto(out, t0, rate, { freq: 95 / Math.sqrt(voice.weight), t60: 0.2, amp: 0.8, drift: -0.35 })
  for (const [f, amp, t60] of [
    [230, 0.35, 0.45],
    [370, 0.3, 0.38],
    [610, 0.22, 0.3],
    [890, 0.15, 0.25],
  ] as const) {
    ringInto(out, t0, rate, { freq: f * voice.pitch * between(r, 0.96, 1.04), t60: t60 * Math.sqrt(voice.ring), amp: amp * voice.ring, phase: r() })
  }
  const latch = t0 + Math.round(between(r, 0.025, 0.04) * rate)
  tick(out, latch, rate, r, 0.5)
  ringInto(out, latch, rate, { freq: 2400 * voice.pitch, t60: 0.06, amp: 0.12 })
  toPeak(out)
  return out
}

// --- Шаг по маршу ------------------------------------------------------------------------

/**
 * Шаг по стальному маршу: щелчок, три моды проступи и дребезг. Набор из
 * `count` шагов, каждый чуть другой - играется случайный.
 */
export function* bakeSteel(rate: number, count = 8, seed = 83): Generator<void, Samples[]> {
  const r = rng(seed)
  const out: Samples[] = []
  for (let s = 0; s < count; s++) {
    const d = new Float32Array(Math.round(0.3 * rate))
    const t0 = Math.round(0.002 * rate)
    addGrain(d, t0, rate, r, { freq: 3000, q: 0.7, attack: 0.0003, decay: 0.003, amp: 0.8 })
    for (const [f, amp, t60] of [
      [870, 0.5, 0.14],
      [1410, 0.35, 0.11],
      [2260, 0.22, 0.08],
    ] as const) {
      ringInto(d, t0, rate, { freq: f * between(r, 0.92, 1.08), t60: t60 * between(r, 0.85, 1.1), amp, phase: r() })
    }
    // Нога: глухо и коротко, сталь под ней не звенит басом.
    ringInto(d, t0, rate, { freq: between(r, 100, 130), t60: 0.05, amp: 0.3 })
    // Дребезг: незакреплённая проступь отвечает вторым, слабым щелчком.
    const rattle = t0 + Math.round(between(r, 0.01, 0.02) * rate)
    addGrain(d, rattle, rate, r, { freq: 4000, q: 1, attack: 0.0002, decay: 0.002, amp: 0.45 })
    for (const f of [1730, 2890]) ringInto(d, rattle, rate, { freq: f * between(r, 0.95, 1.05), t60: 0.05, amp: 0.2, phase: r() })
    toPeak(d)
    out.push(d)
    yield
  }
  return out
}

// --- Корпус --------------------------------------------------------------------------------

/** Стон корпуса: длина, отношения мод к основной, спад. */
export const GROAN = {
  seconds: 5.5,
  base: [40, 70],
  ratios: [1, 1.37, 1.93, 2.61, 3.28],
  t60: [2, 5],
  top: 200,
} as const

export function renderGroan(rate: number, seed = Math.random() * 1e9): Samples {
  const r = rng(seed >>> 0)
  const n = Math.round(GROAN.seconds * rate)
  const out = new Float32Array(n)
  const f0 = between(r, GROAN.base[0], GROAN.base[1])
  const count = 3 + Math.floor(r() * 3)
  const attack = between(r, 0.08, 0.25)
  let made = 0
  for (const ratio of GROAN.ratios) {
    if (made >= count) break
    const f = f0 * ratio * between(r, 0.97, 1.03)
    if (f > GROAN.top) break
    ringInto(out, 0, rate, {
      freq: f,
      t60: between(r, GROAN.t60[0], GROAN.t60[1]),
      amp: 1 / (1 + made * 0.35),
      attack: attack * between(r, 0.8, 1.3),
      drift: between(r, -0.02, 0.02),
      phase: r(),
    })
    made++
  }
  // Под модами - низкий шорох нагрузки, глуше 100 Гц.
  const rumble = new Float32Array(n)
  addGrain(rumble, 0, rate, r, { type: 'lowpass', freq: 90, q: 0.7, attack, decay: 1.5, amp: 0.6 })
  for (let i = 0; i < n; i++) out[i] += rumble[i]
  toPeak(out)
  return out
}

// --- Стартёр ---------------------------------------------------------------------------------

/** Щелчок стартёра на провале и «тинк» зажигания на возврате. */
export function renderStarter(rate: number, kind: 'click' | 'tink', seed = Math.random() * 1e9): Samples {
  const r = rng(seed >>> 0)
  const d = new Float32Array(Math.round(0.05 * rate))
  const t0 = Math.round(0.001 * rate)
  addGrain(d, t0, rate, r, { freq: logBetween(r, 2000, 4000), q: 2, attack: 0.0002, decay: 0.002, amp: kind === 'click' ? 1 : 0.5 })
  if (kind === 'tink') ringInto(d, t0, rate, { freq: logBetween(r, 3000, 5000), t60: between(r, 0.01, 0.03), amp: 1 })
  toPeak(d)
  return d
}
