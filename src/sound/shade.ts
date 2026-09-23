/**
 * sound/shade.ts - затенение на узлах: срез верха и место источника по тому,
 * что насчитал `hear.ts`.
 *
 * `Shaded` - источник за преградой: фильтр среза, за ним место (`Spot`:
 * громкость, панорама, сухо и посыл). Фильтр едет `setTargetAtTime` с
 * постоянной 0.15 с - без щелчков, - и пишется редко: только когда срез ушёл
 * заметно и не чаще раза в `WRITE_EVERY`, кроме смены зоны - тогда сразу.
 *
 * `createOutside` - улица для тех, кто внутри. Слои поляны, гром и опушка
 * звучат не прямо в шины микшера, а в такие же шины улицы, и те идут в
 * микшер через одно общее затенение: пока ухо снаружи, оно пропускает всё;
 * внутри - как дверь или стена между ухом и улицей.
 */

import type { Heard } from './hear'
import { SEND, SHADE } from './levels'
import type { Bus, Mixer } from './mixer'
import { panOf, qOf, Spot, WRITE_EVERY, type Ear, type How } from './place'

/** Полная полоса: срез у верхней границы слуха, ниже Найквиста с запасом. */
export function fullBand(ctx: BaseAudioContext): number {
  return Math.min(20000, ctx.sampleRate * 0.45)
}

/** Срез: пишет в узел только заметную перемену и не чаще `WRITE_EVERY`, кроме сдвига. */
class Cutoff {
  private hz = -1
  private at = -Infinity

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly node: BiquadFilterNode,
    private readonly full: number
  ) {}

  set(target: number, how: How): void {
    const hz = Math.min(this.full, target)
    const t = this.ctx.currentTime
    if (how === 'now' || how === 'fade' || this.hz < 0) {
      this.node.frequency.setValueAtTime(hz, t)
    } else {
      if (Math.abs(Math.log(hz / this.hz)) < 0.05) return
      if (how === 'glide' && t - this.at < WRITE_EVERY) return
      this.node.frequency.setTargetAtTime(hz, t, SHADE.tau)
    }
    this.hz = hz
    this.at = t
  }
}

/** Источник за преградой: голос подключается к `input`. */
export class Shaded {
  readonly input: BiquadFilterNode
  readonly spot: Spot
  private readonly cut: Cutoff

  constructor(mix: Bus, o: { out?: AudioNode; wet?: number; stereo?: boolean } = {}) {
    const ctx = mix.ctx
    const full = fullBand(ctx)
    this.input = ctx.createBiquadFilter()
    this.input.type = 'lowpass'
    this.input.Q.value = qOf('lowpass', Math.SQRT1_2)
    this.input.frequency.value = full
    this.spot = new Spot(mix, o)
    this.input.connect(this.spot.input)
    this.cut = new Cutoff(ctx, this.input, full)
  }

  /**
   * Поставить по услышанному. `gain` - множитель поверх затенения (обычно 1:
   * уровень задаёт сам голос), `spread` - насколько панорама идёт за местом.
   */
  set(h: Heard, ear: Ear, how: How, gain = 1, spread = 1): void {
    this.cut.set(h.cutoff, how)
    this.spot.set(gain * h.gain, panOf(ear, h.at) * spread, how)
  }
}

/** Улица, слышная изнутри: шины для слоёв поляны и одно затенение на всех. */
export type Outside = ReturnType<typeof createOutside>

export function createOutside(mix: Mixer) {
  const ctx = mix.ctx
  // Три дорожки: сухо, мимо свёртки и посыл. Панорама у двух первых - к проёму
  // или стене, откуда улица слышна; посыл не панорамируется.
  const dry = new Shaded(mix, { out: mix.dry, wet: 0, stereo: true })
  const weather = new Shaded(mix, { out: mix.weather, wet: 0, stereo: true })
  const send = new Shaded(mix, { out: mix.send, wet: 0, stereo: true })
  const sfx = ctx.createGain()
  sfx.connect(dry.input)
  const wet = ctx.createGain()
  wet.gain.value = SEND.near
  sfx.connect(wet).connect(send.input)
  const bus: Bus = { ctx, dry: dry.input, weather: weather.input, send: send.input, sfx }
  /** Панорама улицы изнутри: к проёму, но не до края - шум дождя огибает голову. */
  const SPREAD = 0.7
  return {
    bus,
    set(h: Heard, ear: Ear, how: How): void {
      dry.set(h, ear, how, 1, SPREAD)
      weather.set(h, ear, how, 1, SPREAD)
      send.set(h, ear, how, 1, 0)
    },
  }
}
