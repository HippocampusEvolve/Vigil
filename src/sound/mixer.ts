/**
 * sound/mixer.ts - шины мира и мастер.
 *
 * Разводка:
 *   sfx       источники с местом: звучат сухо (`dry`) и параллельно, копией
 *             через `send`, в свёртки пространств. У каждой свёртки своя шина
 *             возврата, между ними - перекрёстное затухание (`setSpace`);
 *   weather   дождь, дробь по кровлям, ветер - мимо свёртки: свёртка шума шумом
 *             ничего не добавляет, а стоит как любая другая;
 *   director  директор напряжения (сердце, дыхание, гул тревоги) - своя шина;
 *   phones    канал пульта в наушниках - своя шина, сухо и стерео;
 *   master    всё сходится сюда; громкость появления мира - его усиление.
 * За мастером - заслон от постоянной составляющей, лимитер и потолок: пики не
 * выше -1 dBFS, как бы громко ни стало. Игрок прибавит звук в тишине, и тогда
 * гром не должен ранить.
 *
 * Мир и наушники разведены до мастера нарочно: когда игрок наденет наушники,
 * смесь мира (`world`) уйдёт за срез 600 Гц и -12 дБ, а канал пойдёт мимо.
 * Среза пока нет вовсе: пропускающий всё фильтр у самой Найквистовой частоты
 * не бесплатен и не прозрачен, и появится он вместе с наушниками.
 *
 * Модуль строит граф на переданном контексте и больше ничего не трогает:
 * тем же кодом его прогоняет проверка звука на Node, без звуковой карты.
 */

import { db } from './dsp'
import { SEND } from './levels'
import { qOf } from './place'
import type { SpaceKind } from './reverb'

/**
 * Сколько отражений возвращается в смесь, по пространствам. Свёртка с
 * нормировкой отдаёт тем больше, чем длиннее отклик, поэтому у короткого леса
 * возврат выше.
 */
export const RETURN: Record<SpaceKind, number> = { forest: 1.4, post: 1.0, lower: 0.9 }

/** Постоянная перекрёстного затухания пространств, с. */
export const SPACE_TAU = 0.35

/**
 * Лимитер. Компрессор WebAudio сам поднимает тихое («компенсация усиления» по
 * спецификации: показатель 0.6 от того, сколько кривая отнимает на 0 dBFS).
 * Лимитеру это не нужно - тихое должно остаться тихим, - поэтому подъём тут же
 * снимается обратно тем же числом.
 */
const LIMIT = { threshold: -4, ratio: 20, attack: 0.002, release: 0.2 } as const
const MAKEUP_DB = 0.6 * -LIMIT.threshold * (1 - 1 / LIMIT.ratio)

/** Потолок: выше -1 dBFS не выходит ничто. До -3 dBFS кривая прямая, выше мягко гнётся к потолку. */
const CEILING = db(-1)
const KNEE = 0.7
/** Сколько сверх единицы кривая ещё гнёт мягко; дальше - ровно потолок. */
const RANGE = 2

/** Кривая потолка для `WaveShaperNode`: нечётная длина, чтобы ноль шёл в ноль. */
function ceilingCurve(): Float32Array<ArrayBuffer> {
  const n = 4097
  const curve = new Float32Array(n)
  const room = CEILING - KNEE
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * RANGE
    const a = Math.abs(x)
    const y = a < KNEE ? a : KNEE + room * Math.tanh((a - KNEE) / room)
    curve[i] = Math.sign(x) * y
  }
  return curve
}

export type Mixer = ReturnType<typeof createMixer>

/**
 * Шины, в которые звучат источники: сухо, мимо свёртки и посылом в
 * пространство. У микшера они свои; у улицы внутри поста - те же шины, но
 * через затенение входной двери (`shade.ts`).
 */
export type Bus = { ctx: BaseAudioContext; dry: AudioNode; weather: AudioNode; send: AudioNode; sfx: AudioNode }

export function createMixer(ctx: BaseAudioContext, opts: { limit?: boolean } = {}) {
  const gain = (v = 1): GainNode => {
    const n = ctx.createGain()
    n.gain.value = v
    return n
  }

  const master = gain(1)
  const world = gain(1)
  const plainGain = gain(1)
  world.connect(plainGain).connect(master)
  // The world passes through a sleeve filter when headphones are worn.
  const sleeve = ctx.createBiquadFilter()
  sleeve.type = 'lowpass'
  sleeve.frequency.value = 20000
  const sleeveGain = gain(0)
  world.connect(sleeve).connect(sleeveGain).connect(master)

  const dry = gain(1)
  dry.connect(world)
  const weather = gain(1)
  weather.connect(world)
  const send = gain(1)
  // Удобная шина для чужих разовых звуков: сухо и с обычным посылом.
  const sfx = gain(1)
  sfx.connect(dry)
  sfx.connect(gain(SEND.near)).connect(send)

  const director = gain(1)
  director.connect(master)
  const phones = gain(1)
  phones.connect(master)

  // Свёртки. Каждая подключается к посылу, только когда её пространство
  // впервые понадобилось: свёртка с откликом считает всегда, пока на входе есть
  // звук, даже если её возврат заглушён.
  const kinds: SpaceKind[] = ['forest', 'post', 'lower']
  const spaces = {} as Record<SpaceKind, { conv: ConvolverNode; back: GainNode; wired: boolean; weight: number }>
  for (const kind of kinds) {
    const conv = ctx.createConvolver()
    conv.normalize = true
    const back = gain(0)
    conv.connect(back).connect(world)
    spaces[kind] = { conv, back, wired: false, weight: 0 }
  }

  // Заслон от постоянной составляющей: срез на 10 Гц ниже всего слышимого, а
  // волну возвращает на ноль - и вместе с ней запас по громкости.
  const dcBlock = ctx.createBiquadFilter()
  dcBlock.type = 'highpass'
  dcBlock.frequency.value = 10
  dcBlock.Q.value = qOf('highpass', Math.SQRT1_2)
  master.connect(dcBlock)

  if (opts.limit ?? true) {
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = LIMIT.threshold
    comp.knee.value = 0
    comp.ratio.value = LIMIT.ratio
    comp.attack.value = LIMIT.attack
    comp.release.value = LIMIT.release
    const shaper = ctx.createWaveShaper()
    shaper.curve = ceilingCurve()
    shaper.oversample = 'none'
    dcBlock.connect(comp).connect(gain(db(-MAKEUP_DB))).connect(gain(1 / RANGE)).connect(shaper).connect(ctx.destination)
  } else {
    // Без лимитера - только для проверки: так видно, что синтез не клиппует
    // сам, а не что его вовремя поймали.
    dcBlock.connect(ctx.destination)
  }

  /**
   * Пространства по долям: {forest: 1} - лес целиком. Доли меняются
   * перекрёстным затуханием с постоянной `SPACE_TAU`, как `setIndoor` в
   * Snowfall; `now` - сразу, без затухания.
   */
  function setSpace(weights: Partial<Record<SpaceKind, number>>, immediate = false): void {
    const t = ctx.currentTime
    for (const kind of kinds) {
      const s = spaces[kind]
      const w = Math.max(0, Math.min(1, weights[kind] ?? 0))
      if (w === s.weight) continue
      s.weight = w
      if (w > 0 && !s.wired) {
        send.connect(s.conv)
        s.wired = true
      }
      if (immediate) s.back.gain.setValueAtTime(RETURN[kind] * w, t)
      else s.back.gain.setTargetAtTime(RETURN[kind] * w, t, SPACE_TAU)
    }
  }

  /** Отдать свёртке её отклик. Ставится один раз, когда отклик посчитан. */
  function setImpulse(kind: SpaceKind, buffer: AudioBuffer): void {
    const s = spaces[kind]
    if (!s.conv.buffer) s.conv.buffer = buffer
  }

  return {
    ctx,
    master,
    world,
    dry,
    weather,
    send,
    sfx,
    director,
    phones,
    setHeadphones(on: boolean): void {
      const t = ctx.currentTime
      sleeve.frequency.setTargetAtTime(on ? 600 : 20000, t, 0.12)
      plainGain.gain.setTargetAtTime(on ? 0 : 1, t, 0.12)
      sleeveGain.gain.setTargetAtTime(on ? db(-12) : 0, t, 0.12)
    },
    setSpace,
    setImpulse,
  }
}
