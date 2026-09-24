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
import { createConsoleSound, } from './sound/console'
import type { Step } from './actions/tape'
import { MIC_ENTRY } from './world/layout'
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
  let consoleSound: ReturnType<typeof createConsoleSound> | null = null
  let channel = 0
  let tapeMode = false
  let bank: Bank | null = null
  let watching = false
  let wake = 1
  let written = -1
  let writtenAt = -Infinity
  let rain = 1
  let frogAt = Infinity
  let farField = 0
  let farGain: GainNode | null = null
  let assemble = false
  const doors = shutDoors()
  const lights: Partial<Record<FixtureId, number>> = {}
  let callsign: string | null = null
  let tension = 0.25
  let nextBeat = 0
  let nextBreath = 0
  let hum: OscillatorNode | null = null
  let humGain: GainNode | null = null

  function ensureFarField(): void {
    if (!ctx || !scape || farGain) return
    const low = ctx.createOscillator()
    const high = ctx.createOscillator()
    low.type = high.type = 'sine'
    low.frequency.value = 55
    high.frequency.value = 110.2
    farGain = ctx.createGain()
    farGain.gain.value = farField * 0.003
    low.connect(farGain)
    high.connect(farGain)
    farGain.connect(scape.mix.director)
    low.start()
    high.start()
  }

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
    farGain = null
    scape.mix.world.gain.value = 1 - farField * 0.875
    if (farField) ensureFarField()
    hum = c.createOscillator()
    hum.frequency.value = 85
    hum.type = 'sine'
    humGain = c.createGain()
    humGain.gain.value = 0
    hum.connect(humGain).connect(scape.mix.director)
    hum.start()
    consoleSound = createConsoleSound(c, scape.mix)
    consoleSound.set(channel, tapeMode)
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
    const heartbeat = Math.max(0, (tension - 0.5) / 0.5)
    if (humGain) humGain.gain.value = Math.max(0, (tension - 0.5) / 0.3) * 0.004
    if (heartbeat > 0 && ctx.currentTime >= nextBeat) {
      const at = ctx.currentTime
      const beat = ctx.createOscillator()
      const envelope = ctx.createGain()
      beat.type = 'sine'
      beat.frequency.setValueAtTime(68, at)
      beat.frequency.exponentialRampToValueAtTime(43, at + 0.16)
      envelope.gain.setValueAtTime(0, at)
      envelope.gain.linearRampToValueAtTime(heartbeat * 0.008, at + 0.012)
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.2)
      beat.connect(envelope).connect(scape.mix.director)
      beat.start(at)
      beat.stop(at + 0.21)
      nextBeat = at + 60 / (55 + heartbeat * 55)
    }
    const breathing = Math.max(0, (tension - 0.4) / 0.6)
    if (breathing > 0 && ctx.currentTime >= nextBreath) {
      const at = ctx.currentTime
      const breath = ctx.createOscillator()
      const envelope = ctx.createGain()
      breath.type = 'triangle'
      breath.frequency.setValueAtTime(190, at)
      breath.frequency.linearRampToValueAtTime(125, at + 0.9)
      envelope.gain.setValueAtTime(0, at)
      envelope.gain.linearRampToValueAtTime(breathing * 0.002, at + 0.25)
      envelope.gain.linearRampToValueAtTime(0, at + 0.9)
      breath.connect(envelope).connect(scape.mix.director)
      breath.start(at)
      breath.stop(at + 0.91)
      nextBreath = at + 60 / (12 + breathing * 14)
    }
    // Громкость появления едет каждый кадр; пишем её не чаще 20 раз в секунду.
    const now = ctx.currentTime
    if (rain < 0.05 && ctx.state === 'running') {
      if (!Number.isFinite(frogAt)) frogAt = now + 5
      if (now >= frogAt) {
        const voice = ctx.createOscillator()
        const throat = ctx.createBiquadFilter()
        const gain = ctx.createGain()
        voice.type = 'sawtooth'
        voice.frequency.setValueAtTime(142, now)
        voice.frequency.linearRampToValueAtTime(205, now + 0.16)
        voice.frequency.exponentialRampToValueAtTime(132, now + 0.42)
        throat.type = 'lowpass'; throat.frequency.value = 430
        gain.gain.setValueAtTime(0, now)
        gain.gain.linearRampToValueAtTime(0.011, now + 0.07)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.44)
        voice.connect(throat).connect(gain).connect(scape.outside.bus.sfx)
        voice.start(now); voice.stop(now + 0.45)
        frogAt = now + 3.5 + Math.sin(now * 0.37) * 1.2
      }
    } else frogAt = Infinity
    if (wake !== written && (now - writtenAt >= 0.05 || wake === 0 || wake === 1)) {
      scape.mix.master.gain.setTargetAtTime(wake, now, GAIN_TAU)
      written = wake
      writtenAt = now
    }
  }

  return {
    start,
    listen(value: number, tape = false): void {
      channel = value
      tapeMode = tape
      consoleSound?.set(value, tape)
    },
    get analyser(): AnalyserNode | null { return consoleSound?.analyser ?? null },
    tapeStep(step: Step): void {
      scape?.synth.tapeStep(step.surface, step.x, step.z, step.running, MIC_ENTRY.x, MIC_ENTRY.z)
    },
    tapeCue(kind: string): void {
      if (!ctx || !scape || ctx.state !== 'running') return
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      osc.type = kind === 'fall' ? 'sawtooth' : 'sine'
      osc.frequency.value = kind === 'breath' ? 80 : kind === 'fall' ? 55 : kind === 'hiss' ? 820 : 360
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(kind === 'fall' ? 0.035 : 0.012, now + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'breath' ? 0.7 : kind === 'fall' ? 0.45 : 0.12))
      osc.connect(gain).connect(scape.mix.phones)
      osc.start(now)
      osc.stop(now + 0.8)
    },
    eventCue(kind: string): void {
      if (!ctx || !scape || ctx.state !== 'running') return
      const at = ctx.currentTime
      if (kind === 'pen') {
        const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.28), ctx.sampleRate)
        const data = buffer.getChannelData(0)
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
        for (let i = 0; i < 7; i++) {
          const source = ctx.createBufferSource()
          const filter = ctx.createBiquadFilter()
          const gain = ctx.createGain()
          source.buffer = buffer
          filter.type = 'bandpass'; filter.frequency.value = 1300 + i * 90; filter.Q.value = 1.3
          gain.gain.value = 0.04
          source.connect(filter).connect(gain).connect(scape.mix.sfx)
          source.start(at + i * 0.42)
        }
        return
      }
      if (kind === 'buzzer') {
        const tone = ctx.createOscillator()
        const gain = ctx.createGain()
        tone.type = 'sawtooth'; tone.frequency.value = 240
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(0.017, at + 0.03)
        gain.gain.setValueAtTime(0.017, at + 0.45)
        gain.gain.linearRampToValueAtTime(0, at + 0.65)
        tone.connect(gain).connect(scape.mix.sfx)
        tone.start(at); tone.stop(at + 0.66)
        return
      }
      const knocks = kind === 'knock' ? 3 : 1
      for (let i = 0; i < knocks; i++) {
        const start = at + i * 0.23
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = kind === 'knock' || kind === 'hatch' ? 'triangle' : 'sine'
        osc.frequency.setValueAtTime(kind === 'intercom' ? 650 : kind === 'knock' ? 95 : 180, start)
        osc.frequency.exponentialRampToValueAtTime(55, start + 0.18)
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(kind === 'knock' ? 0.055 : 0.025, start + 0.005)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2)
        osc.connect(gain).connect(scape.mix.sfx)
        osc.start(start)
        osc.stop(start + 0.21)
      }
    },
    update,
    /** Громкость появления: 0 - тишина, 1 - как задумано. */
    setWake(v: number): void {
      wake = Math.max(0, Math.min(1, v))
    },
    setTension(v: number): void { tension = Math.max(0, Math.min(1, v)) },
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
    /** Near the glass the world recedes and a slow beating tone takes its place. */
    setFarField(level: number): void {
      const next = Math.max(0, Math.min(1, level))
      if (next === farField) return
      farField = next
      if (!ctx || !scape) return
      if (next) ensureFarField()
      const t = ctx.currentTime
      const tau = next > 0 ? 0.65 : 1.3
      scape.mix.world.gain.setTargetAtTime(1 - next * 0.875, t, tau)
      farGain?.gain.setTargetAtTime(next * 0.003, t, tau)
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
