/**
 * sound/reverb.ts - три пространства мира: лес, пост и низ.
 *
 * Отклик считается кодом, а не грузится файлом: у мира нет ни одного звукового
 * файла. Свёрток ровно три, по одной на пространство, и источники делят их
 * через общий посыл (`mixer.ts`) - свёртка самый дорогой узел графа.
 *
 * Чем пространства различаются на слух:
 *   ЛЕС   короткий, без ранних отражений, диффузный с нуля: стволы и листва
 *         рассеивают звук, отдельного эха нет. Верх гаснет быстро - по хвосту
 *         срез ползёт от 4 кГц к 800 Гц. T60 0.25-0.35 с.
 *   ПОСТ  бетонные комнаты: ранние отражения на 15-40 мс, под сводом лёгкое
 *         порхающее эхо (гребёнка около 25 мс) - свод фокусирует звук.
 *         T60 0.6-0.8 с.
 *   НИЗ   нижний ярус: плотные отражения 40-150 мс, вода под ногами (сильное
 *         отражение от пола в первые миллисекунды), металлический призвук -
 *         узкие пики 400-900 Гц, которые держатся в хвосте дольше шума.
 *         T60 1.6-2.0 с.
 *
 * Отклики по размеру: T60 леса меньше T60 поста, T60 поста меньше T60 низа.
 */

import { rng, SLICE, type Samples } from './dsp'

export type SpaceKind = 'forest' | 'post' | 'lower'

type Shape = {
  /** Длина отклика, с. */
  seconds: number
  /** Время спада на 60 дБ всей полосы, с. К нему огибающая и подгоняется. */
  t60: number
  /** Срез верха в начале и в конце хвоста, Гц: пространство темнеет по мере спада. */
  hi: readonly [number, number]
  /** За сколько диффузный хвост набирает плотность, с. Ноль - диффузный с нуля. */
  onset: number
  /** Ранние отражения: [мс, сила]. Сила - в долях шума в начале хвоста. */
  early: ReadonlyArray<readonly [number, number]>
  /** Порхающее эхо: повторы с шагом `period` мс, каждый слабее прошлого в `fade` раз. */
  flutter?: { from: number; period: number; count: number; gain: number; fade: number }
  /** Плотная россыпь отражений: `count` штук в окне `[from, to]` мс. */
  cloud?: { from: number; to: number; count: number; gain: number }
  /** Узкие пики в хвосте: [Гц, сила, T60 с]. */
  modes?: ReadonlyArray<readonly [number, number, number]>
}

export const SPACES: Record<SpaceKind, Shape> = {
  forest: {
    seconds: 0.4,
    t60: 0.3,
    hi: [4000, 800],
    onset: 0,
    early: [],
  },
  post: {
    seconds: 1.0,
    t60: 0.7,
    hi: [7000, 2500],
    onset: 0.03,
    early: [
      [15, 3.2],
      [21, 2.4],
      [29, 2.0],
      [38, 1.6],
    ],
    flutter: { from: 44, period: 25, count: 14, gain: 1.8, fade: 0.8 },
  },
  lower: {
    seconds: 2.4,
    t60: 1.8,
    hi: [6000, 1500],
    onset: 0.05,
    early: [[9, 4]],
    cloud: { from: 40, to: 150, count: 30, gain: 4 },
    modes: [
      [437, 0.07, 2.4],
      [562, 0.06, 2.3],
      [689, 0.06, 2.5],
      [823, 0.05, 2.2],
    ],
  },
}

/** Мощность белого шума после однополюсного среза: у кого срез ниже, у того меньше энергии. */
function onePolePower(freq: number, rate: number): number {
  const a = 1 - Math.exp((-2 * Math.PI * freq) / rate)
  return a / (2 - a)
}

/**
 * Собрать отклик пространства: два канала, считаются порознь - одинаковый шум
 * слева и справа схлопывает пространство в точку между ушами.
 *
 * Хвост - шум под экспонентой, пропущенный через однополюсный срез, который
 * по ходу хвоста закрывается. Закрываясь, срез сам уносит энергию, и хвост
 * гаснет быстрее своей огибающей; поэтому огибающая берётся чуть длиннее, ровно
 * настолько, чтобы спад всей полосы вышел заданным `t60`.
 */
export function* bakeImpulse(kind: SpaceKind, rate: number, seed = 7): Generator<void, Samples[]> {
  const s = SPACES[kind]
  const len = Math.max(1, Math.floor(rate * s.seconds))
  const [hi0, hi1] = s.hi
  const lost = (10 * Math.log10(onePolePower(hi0, rate) / onePolePower(hi1, rate))) / s.seconds
  const t60env = 60 / Math.max(1, 60 / s.t60 - lost)
  const r = rng(seed * 7919 + kind.length)
  const out: Samples[] = []

  for (let c = 0; c < 2; c++) {
    const d = new Float32Array(len)
    // Диффузный хвост - шум под экспонентой (она множителем на отсчёт) - и узкие
    // пики: затухающие синусы, которые гаснут медленнее шума и потому выходят в
    // хвосте. Синус без Math.sin: поворот через рекурренту, затухание в ней же.
    const fall = Math.exp(-6.9078 / (t60env * rate))
    const onsetN = s.onset * rate
    // Моды - в плоских массивах: во внутреннем цикле по отсчётам объекты дороги.
    const list = s.modes ?? []
    const c1 = new Float64Array(list.length)
    const c2 = new Float64Array(list.length)
    const s1 = new Float64Array(list.length)
    const s0 = new Float64Array(list.length)
    list.forEach(([hz, g, t60], m) => {
      const ph = r() * Math.PI * 2
      const w = (2 * Math.PI * hz * (1 + (c ? 0.004 : 0))) / rate
      const k = Math.exp(-6.9078 / (t60 * rate))
      c1[m] = 2 * Math.cos(w) * k
      c2[m] = k * k
      s1[m] = g * Math.sin(ph)
      s0[m] = (g / k) * Math.sin(ph - w)
    })
    const count = list.length
    let env = 1
    for (let i = 0; i < len; i++) {
      const grow = i < onsetN ? i / onsetN : 1
      let v = (r() * 2 - 1) * env * grow * grow
      for (let m = 0; m < count; m++) {
        const now = s1[m]
        v += now
        s1[m] = c1[m] * now - c2[m] * s0[m]
        s0[m] = now
      }
      d[i] = v
      env *= fall
      if (i % SLICE === SLICE - 1) yield
    }
    // Ранние отражения; справа они приходят чуть позже и тише, иначе эхо звучит в голове.
    const skew = c === 0 ? 1 : 1.13
    const side = c === 0 ? 1 : 0.9
    const put = (ms: number, g: number) => {
      const at = Math.floor((ms * skew * rate) / 1000)
      if (at < len) d[at] += g * side
    }
    for (const [ms, g] of s.early) put(ms, g)
    if (s.flutter) {
      const f = s.flutter
      let g = f.gain
      for (let k = 0; k < f.count; k++, g *= f.fade) put(f.from + k * f.period, k % 2 ? -g : g)
    }
    if (s.cloud) {
      const f = s.cloud
      for (let k = 0; k < f.count; k++) {
        const ms = f.from + (f.to - f.from) * r()
        const fall = 1 - 0.6 * ((ms - f.from) / (f.to - f.from))
        put(ms, (r() < 0.5 ? -1 : 1) * f.gain * fall * (0.5 + 0.5 * r()))
      }
    }
    // Срез верха закрывается по ходу хвоста.
    let y = 0
    let a = 0
    for (let i = 0; i < len; i++) {
      if ((i & 63) === 0) {
        const fc = hi0 * Math.pow(hi1 / hi0, i / len)
        a = 1 - Math.exp((-2 * Math.PI * fc) / rate)
      }
      y += a * (d[i] - y)
      d[i] = y
      if (i % SLICE === SLICE - 1) yield
    }
    out.push(d)
  }
  return out
}

/** То же разом, без порций: для проверок и для короткого леса, который нужен сразу. */
export function impulseResponse(kind: SpaceKind, rate: number, seed?: number): Samples[] {
  const g = bakeImpulse(kind, rate, seed)
  for (;;) {
    const step = g.next()
    if (step.done) return step.value
  }
}
