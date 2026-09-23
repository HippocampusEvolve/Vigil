/**
 * sound/scape.ts - звук мира на одном контексте: микшер, пространства, слои
 * поляны, разовые звуки и редкие события.
 *
 * Собирается не разом. Граф поляны - полторы сотни узлов, и отклики
 * пространств ставятся в свёртки; всё это работа главного потока. Поэтому
 * сборка - очередь маленьких задач: `work(бюджет)` из кадра подключает слой за
 * слоем, пока не выйдет бюджет. Слой, которому не хватает посчитанной петли
 * (`bank.ts`), ждёт в очереди до следующего кадра, а подключившись на ходу,
 * вплывает, а не щёлкает.
 */

import type { Bank, BankName } from './bank'
import { createMixer } from './mixer'
import { createRare, defaultEar, makeLayer, OUTDOOR, type Layer, type LayerName, type Weather } from './outdoor'
import type { Ear } from './place'
import type { SpaceKind } from './reverb'
import { createSynth } from './synth'
import { WAKE_POINT } from '../world/layout'
import { BODY } from '../player'

const IMPULSE: Record<SpaceKind, BankName> = { forest: 'irForest', post: 'irPost', lower: 'irLower' }

export type Scape = ReturnType<typeof createScape>

export function createScape(
  ctx: BaseAudioContext,
  bank: Bank,
  opts: {
    /** Лимитер на мастере. Снимается только в проверке. */
    limit?: boolean
    /** Какие слои поляны собрать. По умолчанию все. */
    layers?: readonly LayerName[]
    /** Редкие события на опушке. */
    rare?: boolean
    /** Посыл разовых звуков в пространство вместо обычного (проверка меряет сухой звук). */
    wet?: number
  } = {}
) {
  const mix = createMixer(ctx, { limit: opts.limit })
  mix.setSpace({ forest: 1 }, true)
  const weather: Weather = { rain: 1 }
  let ear: Ear = defaultEar(WAKE_POINT, BODY.eye)
  const synth = createSynth(mix, bank, () => ear, { wet: opts.wet })
  const rare = (opts.rare ?? true) ? createRare(synth) : null
  const layers = new Map<LayerName, Layer>()

  const impulse = (kind: SpaceKind) => (): boolean => {
    const b = bank.buffer(ctx, IMPULSE[kind])
    if (!b) return false
    mix.setImpulse(kind, b)
    return true
  }
  const layer = (name: LayerName) => (): boolean => {
    const l = makeLayer(name, mix, bank, weather)
    if (!l) return false
    layers.set(name, l)
    // До старта контекста вплывать некуда - ставим сразу; на ходу - вплываем.
    l.place(ear, ctx.currentTime > 0 ? 'fade' : 'now')
    return true
  }
  const tasks: Array<() => boolean> = [
    impulse('forest'),
    ...(opts.layers ?? OUTDOOR).map(layer),
    impulse('post'),
    impulse('lower'),
  ]

  /**
   * Подключать, пока не выйдет бюджет. Одна задача берётся всегда, даже если
   * бюджет уже съеден, - иначе очередь могла бы не сдвинуться никогда.
   * Возвращает, подключилось ли хоть что-то.
   */
  function work(budgetMs: number): boolean {
    const t0 = performance.now()
    let done = false
    for (let i = 0; i < tasks.length; ) {
      if (tasks[i]()) {
        tasks.splice(i, 1)
        done = true
      } else i++
      if (performance.now() - t0 >= budgetMs) break
    }
    return done
  }

  return {
    mix,
    synth,
    work,
    /** Сколько задач сборки осталось. */
    get pending(): number {
      return tasks.length
    },
    /** Где ухо. `now` - поставить всё сразу, без плавности (проверка, первый кадр). */
    place(e: Ear, now = false): void {
      ear = e
      for (const l of layers.values()) l.place(ear, now ? 'now' : 'glide')
    },
    /** Кадр: место уха и часы редких событий. */
    update(dt: number, e?: Ear): void {
      if (e) ear = e
      for (const l of layers.values()) l.place(ear, 'glide')
      rare?.tick(dt)
    },
    get ear(): Ear {
      return ear
    },
    /** Сила дождя 0..1: дождь, лужи, завеса и водосток идут за ней. */
    setRain(level: number): void {
      weather.rain = Math.max(0, Math.min(1, level))
    },
    /** Обрыв насекомых в момент `at` по часам контекста (по умолчанию - сейчас). */
    cutInsects(at = ctx.currentTime): void {
      layers.get('insects')?.cut?.(at)
    },
  }
}
