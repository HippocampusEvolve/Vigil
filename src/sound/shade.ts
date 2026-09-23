/**
 * sound/shade.ts - затенение на узлах: срез верха и место источника по тому,
 * что насчитал `hear.ts`.
 *
 * `Shaded` - источник за преградой: срез верха, за ним место (`Spot`:
 * громкость, панорама, сухо и посыл). Срез едет `setTargetAtTime` с
 * постоянной 0.15 с - без щелчков, - и пишется редко: только когда он ушёл
 * заметно и не чаще раза в `WRITE_EVERY`, кроме смены зоны - тогда сразу. В
 * полной полосе фильтра на пути нет вовсе (`OPEN_ABOVE`).
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

/**
 * Выше этого среза затенения нет вовсе: звук идёт мимо фильтра. Полная полоса
 * - это не фильтр на краю слуха, а его отсутствие: срез на 20 кГц звенит у
 * самого Найквиста и на резком фронте (треск близкого удара) поднимает пик на
 * 3-5 дБ, а срез ровно на Найквисте по формулам спецификации ставит полюса на
 * единичную окружность, и в движке без особого случая для него (так у
 * node-web-audio-api) там копится звон на 24 кГц - снято счётом. Поэтому у
 * источника две дороги, прямая и через фильтр, и между ними перекрёстное
 * затухание. Доля частоты дискретизации: на 48 кГц это 19.2 кГц.
 */
export const OPEN_ABOVE = 0.4

/**
 * Срез одного источника: фильтр и две дороги. Пишет в узлы только заметную
 * перемену и не чаще `WRITE_EVERY`, кроме сдвига; всё едет `setTargetAtTime`
 * с постоянной `SHADE.tau`. Уходя в полную полосу, фильтр едет к
 * `OPEN_ABOVE`, а звук тем временем перетекает на прямую дорогу.
 */
class Band {
  private hz = -1
  private at = -Infinity
  private readonly top: number

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly filter: BiquadFilterNode,
    private readonly direct: GainNode,
    private readonly through: GainNode
  ) {
    this.top = ctx.sampleRate * OPEN_ABOVE
    filter.frequency.value = this.top
    direct.gain.value = 1
    through.gain.value = 0
  }

  set(target: number, how: How): void {
    const hz = Math.min(this.top, target)
    const open = hz >= this.top
    const t = this.ctx.currentTime
    const now = how === 'now' || how === 'fade' || this.hz < 0
    if (!now) {
      if (Math.abs(Math.log(hz / this.hz)) < 0.05) return
      if (how === 'glide' && t - this.at < WRITE_EVERY) return
    }
    const put = (p: AudioParam, v: number) => (now ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, SHADE.tau))
    put(this.filter.frequency, hz)
    put(this.direct.gain, open ? 1 : 0)
    put(this.through.gain, open ? 0 : 1)
    this.hz = hz
    this.at = t
  }
}

/** Источник за преградой: голос подключается к `input`. */
export class Shaded {
  readonly input: GainNode
  readonly spot: Spot
  private readonly band: Band

  constructor(mix: Bus, o: { out?: AudioNode; wet?: number; stereo?: boolean } = {}) {
    const ctx = mix.ctx
    this.input = ctx.createGain()
    this.spot = new Spot(mix, o)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.Q.value = qOf('lowpass', Math.SQRT1_2)
    const direct = ctx.createGain()
    const through = ctx.createGain()
    this.input.connect(direct).connect(this.spot.input)
    this.input.connect(filter).connect(through).connect(this.spot.input)
    this.band = new Band(ctx, filter, direct, through)
  }

  /**
   * Поставить по услышанному. `gain` - множитель поверх затенения (обычно 1:
   * уровень задаёт сам голос), `spread` - насколько панорама идёт за местом.
   */
  set(h: Heard, ear: Ear, how: How, gain = 1, spread = 1): void {
    this.band.set(h.cutoff, how)
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
