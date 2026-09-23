/**
 * ambient.ts — звук мира: один аудиоконтекст, его рождение и сон.
 *
 * Весь звук мира - синтез на WebAudio, без единого файла; сам он живёт в
 * `sound/`. Здесь только жизнь контекста:
 *   - контекст рождается по жесту игрока (`start`), второй не заводится;
 *   - первым касанием играется пустой буфер: без него iOS не будит аудиосессию;
 *   - ушли со вкладки - контекст спит, вернулись - просыпается; `interrupted`
 *     у Safari после звонка лечится тем же `resume`, мёртвый (`closed`)
 *     контекст пересоздаётся;
 *   - дорогие петли считаются заранее, порциями из кадра (`sound/bank.ts`), и
 *     начинают считаться ещё до жеста: для счёта контекст не нужен.
 *
 * Уровень появления запоминается здесь, а не пишется в узел сразу: контекст
 * может завестись позже конца появления, и тогда мир остался бы немым
 * насовсем. Мастер получает запомненное значение при рождении и потом в
 * каждом `update`. Так же запоминаются двери, свет и позывной: мир может
 * сказать про них раньше, чем игрок разбудит звук.
 *
 * Что звать из кадра и по событиям:
 *   update(dt, ear)        каждый кадр - ухо и часы;
 *   setDoor(id, open)      каждый кадр - доля открытия каждой двери, 0..1;
 *                          дёшево, если ничего не изменилось;
 *   doorEvent(id, kind)    по событию двери: 'unlock' - лязг замка, 'open' и
 *                          'close' - скрип створки (`speed` - её скорость,
 *                          рад/с), 'shut' - удар о коробку;
 *   setLights(powers)      каждый кадр - сила каждого светильника 0..1: гул
 *                          трубки идёт за ней, провал ниже половины и возврат -
 *                          щелчок и «тинк» стартёра;
 *   setCallsign(pattern)   позывной в эфире приёмника точками и тире, или null;
 *   step(surface, x, z)    каждый шаг игрока.
 *
 * Модуль не трогает DOM при импорте: тот же код прогоняет проверка звука на
 * Node, где нет ни документа, ни звуковой карты.
 */

import { createBank, type Bank } from './sound/bank'
import { shutDoors } from './sound/hear'
import type { DoorEvent } from './sound/inside'
import type { Ear } from './sound/place'
import { createScape, type Scape } from './sound/scape'
import type { Surface } from './support'
import type { DoorId, FixtureId } from './world/zones'

export type Ambient = ReturnType<typeof createAmbient>

/** Постоянная сглаживания громкости, с: смена уровня без щелчка. */
const GAIN_TAU = 0.05

/**
 * Сколько миллисекунд звук может считать и собираться за кадр. Порция
 * перебирает бюджет не больше чем на один шаг счёта или один слой графа.
 */
const WORK_MS = 4

/** Частота, на которой петли считаются до рождения контекста: у почти всех устройств она такая. */
const BANK_RATE = 48000

export function createAmbient() {
  let ctx: AudioContext | null = null
  let scape: Scape | null = null
  let bank: Bank | null = null
  let watching = false
  let wake = 1
  let written = -1
  let writtenAt = -Infinity
  let rain = 1
  let assemble = false
  const doors = shutDoors()
  const lights: Partial<Record<FixtureId, number>> = {}
  let callsign: string | null = null

  function build(): void {
    const c = new AudioContext()
    ctx = c
    // Пустой буфер в первом же жесте: так iOS будит аудиосессию.
    const blank = c.createBufferSource()
    blank.buffer = c.createBuffer(1, 1, c.sampleRate)
    blank.connect(c.destination)
    blank.start(0)

    bank ??= createBank(c.sampleRate)
    scape = createScape(c, bank)
    scape.setRain(rain)
    for (const [id, v] of Object.entries(doors) as Array<[DoorId, number]>) scape.setDoor(id, v)
    scape.setLights(lights)
    scape.setCallsign(callsign)
    scape.mix.master.gain.value = wake
    written = wake
  }

  /** Запускается по жесту пользователя. Повторный вызов будит контекст. */
  function start(): void {
    if (ctx && ctx.state !== 'closed') {
      // `interrupted` - состояние Safari после звонка: лечится тем же resume.
      if (ctx.state !== 'running') void ctx.resume().catch(() => {})
      return
    }
    build()
    // Ушли со вкладки - замолкаем, вернулись - поднимаем контекст.
    if (!watching && typeof document !== 'undefined') {
      watching = true
      document.addEventListener('visibilitychange', () => {
        if (!ctx) return
        if (document.hidden) void ctx.suspend().catch(() => {})
        else if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => {})
      })
    }
  }

  /**
   * Кадр. `ear` - положение глаза и направление взгляда в сетке мира; без него
   * источники остаются там, где их поставили в прошлый раз.
   */
  function update(dt: number, ear?: Ear): void {
    bank ??= createBank(BANK_RATE)
    if (ctx && scape) scape.update(dt, ear)
    // Одна порция работы на кадр: через кадр - сборка графа, в остальные - счёт
    // петель. Вместе в один кадр они не попадают, и кадр не вырастает вдвое.
    assemble = !assemble
    const built = ctx && scape && scape.pending > 0 && assemble ? scape.work(WORK_MS) : false
    if (!built && bank.pending > 0) bank.work(WORK_MS)
    if (!ctx || !scape) return
    // Громкость появления едет каждый кадр; пишем её не чаще 20 раз в секунду.
    const now = ctx.currentTime
    if (wake !== written && (now - writtenAt >= 0.05 || wake === 0 || wake === 1)) {
      scape.mix.master.gain.setTargetAtTime(wake, now, GAIN_TAU)
      written = wake
      writtenAt = now
    }
  }

  return {
    start,
    update,
    /** Громкость появления: 0 - тишина, 1 - как задумано. */
    setWake(v: number): void {
      wake = Math.max(0, Math.min(1, v))
    },
    /** Шаг игрока по поверхности в точке (x, z): грязь, бетон, вода, сталь марша. */
    step(surface: Surface, x: number, z: number, running: boolean): void {
      scape?.synth.step(surface, x, z, running)
    },
    /** Доля открытия двери 0..1. Зовётся каждый кадр; дёшево, если не изменилось. */
    setDoor(id: DoorId, open: number): void {
      const v = Math.max(0, Math.min(1, open))
      if (v === doors[id]) return
      doors[id] = v
      scape?.setDoor(id, v)
    },
    /** Разовый звук двери: лязг замка, скрип створки со скоростью `speed` рад/с, удар о коробку. */
    doorEvent(id: DoorId, kind: DoorEvent, speed?: number): void {
      scape?.door(id, kind, speed)
    },
    /** Сила светильников 0..1, каждый кадр: гул трубок идёт за ней. */
    setLights(powers: Partial<Record<FixtureId, number>>): void {
      Object.assign(lights, powers)
      scape?.setLights(powers)
    },
    /** Позывной в эфире приёмника (точки, тире, пробел между буквами) или null - эфир пуст. */
    setCallsign(pattern: string | null): void {
      callsign = pattern
      scape?.setCallsign(pattern)
    },
    /**
     * Зовётся в момент вспышки: далёкий раскат приходит через `delay` с;
     * близкий удар - треск через 0.2-0.5 с и сразу раскат.
     */
    thunder(delay: number, near: boolean): void {
      scape?.synth.thunder(delay, near)
    },
    /** Обрыв: шина насекомых падает на 40 дБ за 0.3 с и возвращается за 6 с. */
    cutInsects(): void {
      scape?.cutInsects()
    },
    /** Сила дождя 0..1, по умолчанию 1. */
    setRain(level: number): void {
      rain = Math.max(0, Math.min(1, level))
      scape?.setRain(rain)
    },
    /** Контекст и шина для разовых звуков. Второй контекст заводить нельзя. */
    get bus(): { ctx: AudioContext; out: GainNode } | null {
      return ctx && scape && ctx.state === 'running' ? { ctx, out: scape.mix.sfx } : null
    },
    get state(): string {
      return ctx ? ctx.state : 'не запущен'
    },
  }
}
