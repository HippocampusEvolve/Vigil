/**
 * sound/scape.ts - звук мира на одном контексте: микшер, пространства, слои
 * поляны и нутра, разовые звуки и редкие события.
 *
 * Собирается не разом. Граф - несколько сотен узлов, и отклики пространств
 * ставятся в свёртки; всё это работа главного потока. Поэтому сборка - очередь
 * маленьких задач: `work(бюджет)` из кадра подключает слой за слоем, пока не
 * выйдет бюджет. Слой, которому не хватает посчитанной петли (`bank.ts`),
 * ждёт в очереди до следующего кадра, а подключившись на ходу, вплывает, а не
 * щёлкает. Поляна подключается первой, нутро - после неё.
 *
 * Каждый кадр ухо узнаёт свою зону по графу нутра (`hear.ts`):
 *   - пространство (лес, пост, низ) меняется перекрёстным затуханием с
 *     постоянной 0.35 с; у открытой двери между пространствами слышно и
 *     соседнее - по доле открытия и близости к проёму;
 *   - порог входной двери - событие: пройдя его, ухо слышит один низкий
 *     «вздох» давления в середине перехода;
 *   - улица внутри слышна через дверь или стену: все её слои идут через одно
 *     общее затенение (`shade.ts`) и ставятся по уху у того проёма или стены;
 *   - каждый слой нутра ставится по настоящему уху и по графу.
 */

import type { DoorId, FixtureId } from '../world/zones'
import type { Bank, BankName } from './bank'
import { crossedEntry, earZone, hear, outward, shutDoors, sighStart, SIGH, spaceMix, type Hearing, type Source } from './hear'
import { INDOOR, isIndoor, makeIndoor, type IndoorName } from './indoor'
import { createInside, type DoorEvent } from './inside'
import { createMixer } from './mixer'
import { createRare, defaultEar, makeLayer, OUTDOOR, type Layer, type OutdoorName, type Weather } from './outdoor'
import { WRITE_EVERY, type Ear, type How } from './place'
import type { SpaceKind } from './reverb'
import { createOutside } from './shade'
import { createSynth } from './synth'
import { WAKE_POINT } from '../world/layout'
import { BODY } from '../player'

const IMPULSE: Record<SpaceKind, BankName> = { forest: 'irForest', post: 'irPost', lower: 'irLower' }

export type LayerName = OutdoorName | IndoorName

/** Все слои мира: сперва поляна, потом нутро. */
export const ALL: readonly LayerName[] = [...OUTDOOR, ...INDOOR]

/** Улица как источник: площадь, слышная внутри через дверь или стену. */
const STREET: Source = { rooms: ['out'], ref: 1 }

/** Шаг, которым пишутся доли пространств: мельче - на слух не различить, а очередь растёт. */
const SPACE_STEP = 0.05

/** Дверь сдвинулась на столько за раз - затенение едет сразу, без очереди. */
const DOOR_JOLT = 0.3

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

export type Scape = ReturnType<typeof createScape>

export function createScape(
  ctx: BaseAudioContext,
  bank: Bank,
  opts: {
    /** Лимитер на мастере. Снимается только в проверке. */
    limit?: boolean
    /** Какие слои собрать. По умолчанию все. */
    layers?: readonly LayerName[]
    /** Редкие события на опушке. */
    rare?: boolean
    /** Посыл разовых звуков в пространство вместо обычного (проверка меряет сухой звук). */
    wet?: number
  } = {}
) {
  const mix = createMixer(ctx, { limit: opts.limit })
  mix.setSpace({ forest: 1 }, true)
  const outside = createOutside(mix)
  const weather: Weather = { rain: 1 }
  const doors = shutDoors()
  const hearing: Hearing = { ear: defaultEar(WAKE_POINT, BODY.eye), zone: 'out', doors, changed: false }
  const synth = createSynth(mix, bank, () => hearing.ear, { wet: opts.wet, outside: outside.bus })
  const inside = createInside(mix, hearing, synth, { wet: opts.wet })
  const rig = { mix, bank, weather, synth, inside }
  const rare = (opts.rare ?? true) ? createRare(synth) : null
  const layers = new Map<LayerName, Layer>()
  const lights = new Map<FixtureId, number>()
  let callsign: string | null = null
  /** Ухо у проёма или стены, откуда слышна улица: по нему ставятся слои поляны. */
  let streetEar: Ear = hearing.ear
  let placed = false
  let jolt = false
  let sighAt = -Infinity
  let space: Record<SpaceKind, number> = { forest: 1, post: 0, lower: 0 }
  let spaceAt = -Infinity
  outside.set(hear(STREET, hearing.ear, 'out', doors), hearing.ear, 'now')

  const impulse = (kind: SpaceKind) => (): boolean => {
    const b = bank.buffer(ctx, IMPULSE[kind])
    if (!b) return false
    mix.setImpulse(kind, b)
    return true
  }
  const layer = (name: LayerName) => (): boolean => {
    const l = isIndoor(name) ? makeIndoor(name, rig) : makeLayer(name as OutdoorName, outside.bus, bank, weather)
    if (!l) return false
    layers.set(name, l)
    if (l.light && name.startsWith('tube:')) {
      const v = lights.get(name.slice(5) as FixtureId)
      if (v !== undefined) l.light(v)
    }
    if (callsign) l.callsign?.(callsign)
    // До старта контекста вплывать некуда - ставим сразу; на ходу - вплываем.
    l.place(l.inside ? hearing.ear : streetEar, ctx.currentTime > 0 ? 'fade' : 'now', hearing)
    return true
  }
  const names = opts.layers ?? ALL
  const tasks: Array<() => boolean> = [
    impulse('forest'),
    ...names.filter((n) => !isIndoor(n)).map(layer),
    impulse('post'),
    impulse('lower'),
    ...names.filter((n) => isIndoor(n)).map(layer),
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

  /** Доли пространств: пишутся шагом `SPACE_STEP`, не чаще `WRITE_EVERY`, кроме смены зоны. */
  function spaces(now: boolean): void {
    const w = spaceMix(hearing.ear, hearing.zone, doors)
    for (const k of ['forest', 'post', 'lower'] as const) w[k] = Math.round(w[k] / SPACE_STEP) * SPACE_STEP
    const t = ctx.currentTime
    const moved = (['forest', 'post', 'lower'] as const).some((k) => w[k] !== space[k])
    if (!moved) return
    if (!now && !hearing.changed && t - spaceAt < WRITE_EVERY) return
    mix.setSpace(w, now)
    space = w
    spaceAt = t
  }

  /** Где ухо и что оно слышит: зона, пространства, улица, все слои. */
  function refresh(now: boolean): void {
    const t = ctx.currentTime
    const prev = hearing.zone
    const zone = earZone(hearing.ear, placed ? prev : null)
    hearing.changed = placed && !now && zone !== prev
    hearing.zone = zone
    placed = true
    if (hearing.changed && crossedEntry(prev, zone) && t - sighAt >= SIGH.gap) {
      sighAt = t
      inside.sigh(sighStart(t))
    }
    const how: How = now ? 'now' : hearing.changed || jolt ? 'shift' : 'glide'
    jolt = false
    spaces(now)
    const street = hear(STREET, hearing.ear, zone, doors)
    outside.set(street, hearing.ear, how)
    streetEar = street.same ? hearing.ear : outward(street.from, hearing.ear)
    for (const l of layers.values()) l.place(l.inside ? hearing.ear : streetEar, how, hearing)
  }

  return {
    mix,
    synth,
    inside,
    outside,
    work,
    /** Сколько задач сборки осталось. */
    get pending(): number {
      return tasks.length
    },
    /** Где ухо. `now` - поставить всё сразу, без плавности (проверка, первый кадр). */
    place(e: Ear, now = false): void {
      hearing.ear = e
      refresh(now)
    },
    /** Кадр: место уха, часы редких событий и событий нутра. */
    update(dt: number, e?: Ear): void {
      if (e) hearing.ear = e
      refresh(false)
      rare?.tick(dt)
      for (const l of layers.values()) l.tick?.(dt)
    },
    get ear(): Ear {
      return hearing.ear
    },
    /** Зона уха по графу нутра. */
    get zone() {
      return hearing.zone
    },
    /** Сила дождя 0..1: дождь, лужи, завеса, водосток и дробь по кровле идут за ней. */
    setRain(level: number): void {
      weather.rain = clamp01(level)
    },
    /** Обрыв насекомых в момент `at` по часам контекста (по умолчанию - сейчас). */
    cutInsects(at = ctx.currentTime): void {
      layers.get('insects')?.cut?.(at)
    },
    /** Доля открытия двери 0..1. Затенение и пространства пересчитываются в следующем кадре. */
    setDoor(id: DoorId, open: number): void {
      const v = clamp01(open)
      if (Math.abs(v - doors[id]) >= DOOR_JOLT) jolt = true
      doors[id] = v
    },
    /** Разовый звук двери; створка, ударившая в коробку, сразу глушит то, что за ней. */
    door(id: DoorId, kind: DoorEvent, speed?: number): void {
      inside.door(id, kind, speed)
      if (kind === 'shut') jolt = true
    },
    /** Сила светильников 0..1: гул трубок идёт за ней. */
    setLights(powers: Partial<Record<FixtureId, number>>): void {
      for (const [id, v] of Object.entries(powers) as Array<[FixtureId, number | undefined]>) {
        if (v === undefined) continue
        lights.set(id, v)
        layers.get(`tube:${id}`)?.light?.(v)
      }
    },
    /** Позывной в эфире приёмника; `null` - эфир пуст. */
    setCallsign(pattern: string | null): void {
      callsign = pattern
      layers.get('receiver')?.callsign?.(pattern)
    },
  }
}
