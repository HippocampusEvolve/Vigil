/**
 * sound/place.ts - где звучит источник относительно уха.
 *
 * Стерео с ручным законом расстояния: громкость падает обратно расстоянию
 * (`inverse`) от опорного, панорама - по тому, справа источник или слева от
 * взгляда. Объёмное панорамирование (HRTF) дорогое и держится только для
 * немногого за спиной, одновременно не больше шести; на поляне его нет вовсе.
 *
 * Параметры в аудиопоток пишутся редко: не чаще раза в `WRITE_EVERY` с на
 * узел и только когда громкость ушла на полдецибела или панорама заметно
 * сдвинулась. Плавность даёт сам `setTargetAtTime`, а не частота вызовов, и
 * очередь автоматизаций не копится.
 */

import type { Mixer } from './mixer'
import { SEND } from './levels'

/** Ухо: где глаз и куда он смотрит, в сетке мира. */
export type Ear = { x: number; y: number; z: number; fx: number; fy: number; fz: number }

/** Точка в мире. */
export type Point = { x: number; y: number; z: number }

/** Не чаще этого пишем место источника, с. */
export const WRITE_EVERY = 0.25
/** Постоянная, с которой громкость и панорама едут к новому месту, с. */
const GLIDE = 0.2
/** Постоянная входа слоя, который подключился на ходу: вплывает, а не щёлкает. */
const FADE_IN = 0.6

/**
 * Добротность для `BiquadFilterNode`. У lowpass и highpass WebAudio понимает Q
 * как резонанс в децибелах, у остальных - как обычную добротность. Везде в
 * звуке мира добротность пишется обычной (0.7 - Баттерворт), а переводится
 * здесь: «0.7» в децибелах - это уже горб у среза и выброс на крутых фронтах.
 */
export function qOf(type: BiquadFilterType, q: number): number {
  return type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q
}

/** Обратный закон: на опоре и ближе - единица, дальше - опора, делённая на расстояние. */
export function falloff(distance: number, ref: number): number {
  return ref / Math.max(ref, distance)
}

/** Расстояние от уха до точки. */
export function distance(ear: Ear, p: Point): number {
  return Math.hypot(p.x - ear.x, p.y - ear.y, p.z - ear.z)
}

/**
 * Панорама от -1 (слева) до 1 (справа): проекция направления на источник на
 * правую руку. Вертикаль в панораму не идёт. Совсем близкий источник не
 * мечется из стороны в сторону - к опоре панорама сходится к середине.
 */
export function panOf(ear: Ear, p: Point, ref = 1): number {
  const dx = p.x - ear.x
  const dz = p.z - ear.z
  const d = Math.hypot(dx, dz)
  if (d < 1e-6) return 0
  const f = Math.hypot(ear.fx, ear.fz) || 1
  // Правая рука при взгляде (fx, fz) по плоскости: (-fz, fx).
  const side = (dx * -ear.fz + dz * ear.fx) / (d * f)
  return Math.max(-1, Math.min(1, side * Math.min(1, d / ref)))
}

/** Ближайшая к уху точка отрезка по X на высоте `y` и глубине `z`: трубка лампы, кромка навеса. */
export function alongX(ear: Ear, x0: number, x1: number, y: number, z: number): Point {
  return { x: Math.max(x0, Math.min(x1, ear.x)), y, z }
}

/** Ближайшая к уху точка отрезка по Z: ручей вдоль края. */
export function alongZ(ear: Ear, x: number, y: number, z0: number, z1: number): Point {
  return { x, y, z: Math.max(z0, Math.min(z1, ear.z)) }
}

/** Прямоугольник в плане. */
export type Rect = { x0: number; x1: number; z0: number; z1: number }

/** Внутри ли прямоугольника ухо. */
export function inside(ear: Ear, r: Rect): boolean {
  return ear.x >= r.x0 && ear.x <= r.x1 && ear.z >= r.z0 && ear.z <= r.z1
}

/** Ближайшая к уху точка прямоугольника на высоте `y`; если ухо внутри - точка под ним. */
export function nearestInRect(ear: Ear, r: Rect, y: number): Point {
  return { x: Math.max(r.x0, Math.min(r.x1, ear.x)), y, z: Math.max(r.z0, Math.min(r.z1, ear.z)) }
}

/**
 * Место одного источника: громкость, панорама, сухой звук и посыл в
 * пространство. Голос подключается к `input`.
 */
export class Spot {
  readonly input: GainNode
  private readonly panner: StereoPannerNode
  private readonly ctx: BaseAudioContext
  private readonly lift: number
  private gain = -1
  private pan = 0
  private at = -Infinity

  constructor(mix: Mixer, o: { out?: AudioNode; wet?: number; stereo?: boolean } = {}) {
    const ctx = mix.ctx
    this.ctx = ctx
    this.input = ctx.createGain()
    this.input.gain.value = 0
    this.panner = ctx.createStereoPanner()
    // Панорама равной мощности делит моно на два канала, и посередине каждый
    // получает на 3 дБ меньше. Уровни в таблице - это то, что слышит ухо, а не
    // то, что вошло в панораму: моно поднимается на корень из двух, и тогда
    // средняя мощность по каналам равна заданной при любой панораме. Стерео
    // панорама посередине не трогает, ему подъём не нужен.
    this.lift = o.stereo ? 1 : Math.SQRT2
    this.input.connect(this.panner).connect(o.out ?? mix.dry)
    const wet = o.wet ?? SEND.near
    if (wet > 0) {
      const w = ctx.createGain()
      w.gain.value = wet
      this.panner.connect(w).connect(mix.send)
    }
  }

  /**
   * Поставить громкость и панораму. `how`: 'now' - сразу (разовый звук и
   * проверка), 'fade' - первый раз, вплывая, 'glide' - обычное движение, с
   * порогом и не чаще `WRITE_EVERY`.
   */
  set(gain: number, pan: number, how: 'now' | 'fade' | 'glide' = 'glide'): void {
    const t = this.ctx.currentTime
    const g = gain * this.lift
    if (how === 'now') {
      this.input.gain.setValueAtTime(g, t)
      this.panner.pan.setValueAtTime(pan, t)
    } else if (how === 'fade' || this.gain < 0) {
      this.input.gain.setTargetAtTime(g, t, FADE_IN)
      this.panner.pan.setValueAtTime(pan, t)
    } else {
      if (t - this.at < WRITE_EVERY) return
      const moved = Math.abs(20 * Math.log10(Math.max(gain, 1e-6) / Math.max(this.gain, 1e-6))) > 0.5
      const turned = Math.abs(pan - this.pan) > 0.05
      if (!moved && !turned) return
      if (moved) this.input.gain.setTargetAtTime(g, t, GLIDE)
      if (turned) this.panner.pan.setTargetAtTime(pan, t, GLIDE)
    }
    this.gain = gain
    this.pan = pan
    this.at = t
  }

  /**
   * Во сколько раз громче входа выходит более громкий канал при нынешней
   * панораме (без учёта `gain`). Для событий с уровнем по пику: пик задаётся в
   * громком канале, где бы ни стоял источник.
   */
  channelMax(): number {
    const th = ((this.pan + 1) * Math.PI) / 4
    return this.lift * Math.max(Math.cos(th), Math.sin(th))
  }
}
