/**
 * sound/indoor.ts - постоянные слои нутра (sound.md, «Что где звучит»).
 *
 * Каждый слой - источник в своей точке из графа нутра (`SOURCES` и
 * `FIXTURES` в `world/zones.ts`; копий чисел здесь нет) и слышен по графу
 * зон (`hear.ts`): в своей комнате - в полную полосу, через открытый проём -
 * срезанным до 1 кГц, из-за двери или стены - глухо и тише. Каждый кадр слой
 * переставляется по уху, но в узлы пишет редко (`shade.ts`).
 *
 *   ДРОБЬ ПО КРОВЛЕ  изнутри, во всех комнатах под кровлей одинаково: своя у
 *                    свода ангара и у плоской плиты блока (та же петля, плита
 *                    звенит выше). Низ слышит её глухо, сквозь перекрытие.
 *                    Идёт за силой дождя, мимо свёртки.
 *   ТРУБКИ           гул 100 Гц с гармониками у каждой живой трубки (мёртвая
 *                    молчит) и у фитоламп - выше и тоньше. Гул идёт за светом
 *                    (`light`): дуга гаснет - дроссель замолкает. Провал света
 *                    ниже половины и возврат - щелчок стартёра и «тинк»
 *                    зажигания. У мигающих трубок ещё и зуд стартёра.
 *   ГЕНЕРАТОР        «Дед» в генераторной; за дверью и стеной - глухо.
 *   ЧАСЫ             над проёмом в пост; тик-так раз в секунду.
 *   ПРИЁМНИК         шипение с гуляющим центром 500-4000 Гц, редкие свисты
 *                    гетеродина раз в 8-25 с. Позывной (`callsign`) - морзянкой
 *                    раз в 22-28 с, тон 700 Гц, точка 80 мс, на 6 дБ над
 *                    шипением. Какой - решает не звук: по умолчанию эфир пуст.
 *   ПУЛЬТ            лёгкое гудение и писк строчной развёртки экрана 15.6 кГц,
 *                    очень тихо.
 *   ВЕДРО, РАКОВИНА  капель: в полное ведро (ниже, глуше, с «бульком») раз в
 *                    1.6-3.2 с; в раковину лаборатории реже и мельче.
 *   НИЗ              насосы; капель в воду по всему ярусу; редкие долгие стоны
 *                    корпуса раз в 40-90 с; за дверью холодной - ровный глухой
 *                    гул машин.
 *
 * Кубрик - только дробь по своду: своих источников у него нет нарочно.
 */

import { CABLE_SLEEVE, FLOOR, LOWER } from '../world/layout'
import { fixture, FIXTURES, ROOM_IDS, ROOMS, SOURCES, type Fixture, type FixtureId, type RoomId, type ZoneId } from '../world/zones'
import type { Bank } from './bank'
import { db, LOOP_RMS } from './dsp'
import { hear, type Hearing, type Source } from './hear'
import type { Inside } from './inside'
import { LEVEL } from './levels'
import { HUM_SECONDS } from './machines'
import type { Mixer } from './mixer'
import { gain, loop, stereoLoop, type Layer, type Weather } from './outdoor'
import { qOf, type Ear, type How, type Point } from './place'
import { Shaded } from './shade'
import type { Synth } from './synth'

const rand = (a: number, b: number): number => a + (b - a) * Math.random()
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** Какие светильники гудят: трубки и фитолампы. Накаливания и аварийные на батарее молчат, мёртвая трубка - тоже. */
const HUMMING = FIXTURES.filter((f) => (f.kind === 'tube' || f.kind === 'phyto') && f.behavior !== 'dead')

export type TubeName = `tube:${FixtureId}`
export type IndoorName = 'generator' | 'roof' | 'roofBlock' | TubeName | 'clock' | 'receiver' | 'console' | 'bucket' | 'sink' | 'pump' | 'cold' | 'drips' | 'groans'

/** Гудящие светильники: по слою на каждый. */
export const TUBES: readonly TubeName[] = HUMMING.map((f) => `tube:${f.id}` as TubeName)

/** Слои нутра в порядке подключения. Генератор - в списке поляны (`OUTDOOR`): его слышно и оттуда. */
export const INDOOR: readonly IndoorName[] = ['roof', 'roofBlock', ...TUBES, 'clock', 'receiver', 'bucket', 'console', 'sink', 'pump', 'cold', 'drips', 'groans']

export function isIndoor(name: string): name is IndoorName {
  return name === 'generator' || (INDOOR as readonly string[]).includes(name)
}

/** Сколько секунд между событиями нутра: [от, до]. Густота низкая: одиноко - значит редко. */
export const EVERY = {
  whistle: [8, 25],
  call: [22, 28],
  leak: [1.6, 3.2],
  sink: [3, 7],
  drip: [0.8, 2.8],
  groan: [40, 90],
} as const

/** Тише этого (по затенению) событие не заводим: его всё равно не слышно. */
const AUDIBLE = db(-40)

/** Всё, что нужно слоям нутра. */
export type Rig = { mix: Mixer; bank: Bank; weather: Weather; synth: Synth; inside: Inside }

/** Комнаты под сводом ангара и под плитой блока. */
const VAULT_ROOMS: readonly RoomId[] = ROOM_IDS.filter((id) => ROOMS[id].ceiling === 'vault')
const BLOCK_ROOMS: readonly RoomId[] = ROOM_IDS.filter((id) => ROOMS[id].ceiling !== 'vault' && ROOMS[id].space === 'post')

/** Плоская плита блока звенит выше свода: та же петля, сыгранная быстрее. */
const BLOCK_PITCH = 1.22

/** Панорама дроби, услышанной через проём: к проёму, но не до края - кровля широкая. */
const ROOF_SPREAD = 0.6

/** Гул трубки идёт за светом почти сразу, с. */
const HUM_FOLLOW = 0.012

/**
 * Пульт прослушки у задней стены поста, над гильзой кабелей (look.md: 2.8 x
 * 0.7 x 1.1, экран на панели). Своей точки в `SOURCES` у него нет: берём
 * гильзу и поднимаем к экрану.
 */
const CONSOLE: Point = { x: CABLE_SLEEVE.x, y: FLOOR.y + 1.0, z: ROOMS.F.z0 + 0.35 }
/** Частота строчной развёртки экрана, Гц. */
const LINE_HZ = 15625

/** Машины холодной - там, где её свет: посреди комнаты за дверью. */
const COLD = fixture('J')

/** Шипение приёмника: центр гуляет 500-4000 Гц. */
const HISS = { center: 2250, swing: 1750, q: 1.2 } as const

/** Морзянка: длина точки, с, и тон, Гц. */
export const MORSE = { unit: 0.08, tone: 700 } as const

/**
 * Расписание позывного в точках: [начало, конец] каждой посылки. Точка - одна
 * единица, тире - три, между знаками буквы - одна, между буквами (пробел) -
 * три, между словами (`/`) - семь.
 */
export function morse(pattern: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let t = 0
  let inLetter = false
  for (const ch of pattern) {
    if (ch === '.' || ch === '-') {
      if (inLetter) t += 1
      const len = ch === '.' ? 1 : 3
      out.push([t, t + len])
      t += len
      inLetter = true
    } else if (ch === ' ' && inLetter) {
      t += 3
      inLetter = false
    } else if (ch === '/') {
      t += inLetter ? 7 : 4
      inLetter = false
    }
  }
  return out
}

/** Источник, слышный по графу: переставляется по уху, помнит, насколько его слышно. */
function placed(sh: Shaded, src: Source, spread = 1) {
  let heard = 0
  return {
    place(ear: Ear, how: How, h: Hearing): void {
      const x = hear(src, ear, h.zone, h.doors)
      heard = x.gain
      sh.set(x, ear, how, 1, spread)
    },
    get heard(): number {
      return heard
    },
  }
}

// --- Слои ------------------------------------------------------------------------------

function roof(rig: Rig, block: boolean): Layer | null {
  const { mix, bank, weather } = rig
  const ctx = mix.ctx
  const l = bank.buffer(ctx, 'roofL')
  const r = bank.buffer(ctx, 'roofR')
  if (!l || !r) return null
  const { out, rms } = stereoLoop(ctx, l, r, block ? BLOCK_PITCH : 1)
  // Дробь - мимо свёртки, как дождь: свёртка шума шумом ничего не добавляет.
  const sh = new Shaded(mix, { out: mix.weather, wet: 0, stereo: true })
  const level = gain(ctx, 0)
  out.connect(level).connect(sh.input)
  const base = db(LEVEL.roof) / rms
  const at = placed(sh, { rooms: block ? BLOCK_ROOMS : VAULT_ROOMS, ref: 1 }, ROOF_SPREAD)
  let written = -1
  return {
    inside: true,
    place(ear, how, h) {
      at.place(ear, how, h)
      const v = base * weather.rain
      if (v === written) return
      written = v
      if (how === 'now') level.gain.setValueAtTime(v, ctx.currentTime)
      else level.gain.setTargetAtTime(v, ctx.currentTime, 1.5)
    },
  }
}

function tube(f: Fixture, rig: Rig): Layer | null {
  const { mix, bank, inside } = rig
  const ctx = mix.ctx
  const phyto = f.kind === 'phyto'
  const buf = bank.buffer(ctx, phyto ? 'phyto' : 'hum')
  const dying = f.behavior === 'dying'
  const buzzing = dying ? bank.buffer(ctx, 'starter') : null
  if (!buf || (dying && !buzzing)) return null
  const lv = phyto ? LEVEL.phyto : LEVEL.tube
  const sh = new Shaded(mix)
  // Своя расстройка на пару центов и своя медленная дрожь высоты и громкости.
  const src = loop(ctx, buf, Math.random() * HUM_SECONDS, 1 + (Math.random() * 2 - 1) * 0.0015)
  const pitch = ctx.createOscillator()
  pitch.frequency.value = 0.07 + Math.random() * 0.25
  pitch.connect(gain(ctx, 0.0009)).connect(src.playbackRate)
  const base = db(lv.db) / LOOP_RMS
  const amp = gain(ctx, base)
  const breath = ctx.createOscillator()
  breath.frequency.value = 0.05 + Math.random() * 0.15
  breath.connect(gain(ctx, base * 0.12)).connect(amp.gain)
  pitch.start()
  breath.start()
  const power = gain(ctx, 1)
  src.connect(amp).connect(power).connect(sh.input)
  let buzz: GainNode | null = null
  if (buzzing) {
    buzz = gain(ctx, 1)
    loop(ctx, buzzing, Math.random()).connect(gain(ctx, db(LEVEL.starter.db) / LOOP_RMS)).connect(buzz).connect(sh.input)
  }
  const at = placed(sh, { rooms: [f.room], at: { x: f.x, y: f.y, z: f.z }, ref: lv.ref })
  const tickGain = db(LEVEL.starterTick.db)
  let lit = 1
  let dark = false
  let buzzOn = true
  let tickAt = -Infinity
  return {
    inside: true,
    place: at.place,
    light(value) {
      const v = clamp01(value)
      const t = ctx.currentTime
      // Пишем только заметное: мигание - десятки событий в минуту, а не кадр.
      if (Math.abs(v - lit) >= 0.2 || (v !== lit && (v === 0 || v === 1))) {
        power.gain.setTargetAtTime(v, t, HUM_FOLLOW)
        lit = v
      }
      // Зуд стартёра переживает короткие провалы и гаснет только вместе с сетью.
      if (buzz && v > 0 !== buzzOn) {
        buzzOn = v > 0
        buzz.gain.setTargetAtTime(buzzOn ? 1 : 0, t, 0.5)
      }
      const flip = (!dark && v < 0.5) || (dark && v >= 0.5)
      if (!flip) return
      dark = !dark
      if (t - tickAt < 0.06) return
      tickAt = t
      inside.starter(sh.input, dark ? 'click' : 'tink', tickGain)
    },
  }
}

/** «Дед»: петля хода, медленная дрожь - скоростью петли, чтобы не повторялась с ней. */
function generator(rig: Rig): Layer | null {
  const { mix, bank } = rig
  const ctx = mix.ctx
  const buf = bank.buffer(ctx, 'engine')
  const wander = bank.buffer(ctx, 'wander')
  if (!buf || !wander) return null
  const sh = new Shaded(mix)
  const src = loop(ctx, buf)
  const drift = ctx.createOscillator()
  drift.frequency.value = 0.17
  drift.connect(gain(ctx, 0.004)).connect(src.playbackRate)
  drift.start()
  loop(ctx, wander, 5, 0.6).connect(gain(ctx, 0.003)).connect(src.playbackRate)
  src.connect(gain(ctx, db(LEVEL.generator.db) / LOOP_RMS)).connect(sh.input)
  const at = placed(sh, { rooms: [SOURCES.generator.room], at: SOURCES.generator, ref: LEVEL.generator.ref })
  return { inside: true, place: at.place }
}

/** Ровный источник на петле из банка, в точке из `SOURCES`. */
function steady(rig: Rig, name: 'clock' | 'pump', where: Point & { room: RoomId }, lv: { db: number; ref: number }, byPeak: boolean): Layer | null {
  const { mix, bank } = rig
  const ctx = mix.ctx
  const buf = bank.buffer(ctx, name)
  if (!buf) return null
  const sh = new Shaded(mix)
  // У часов петля приведена к пику 1, у насосов - к общему RMS петель.
  loop(ctx, buf, name === 'clock' ? 0 : Math.random() * buf.duration)
    .connect(gain(ctx, db(lv.db) / (byPeak ? 1 : LOOP_RMS)))
    .connect(sh.input)
  const at = placed(sh, { rooms: [where.room], at: where, ref: lv.ref })
  return { inside: true, place: at.place }
}

function receiver(rig: Rig): Layer | null {
  const { mix, bank } = rig
  const ctx = mix.ctx
  const white = bank.buffer(ctx, 'white')
  const wander = bank.buffer(ctx, 'wander')
  if (!white || !wander) return null
  const sh = new Shaded(mix)
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.Q.value = HISS.q
  band.frequency.value = HISS.center
  loop(ctx, wander, 7, 0.25).connect(gain(ctx, HISS.swing)).connect(band.frequency)
  // RMS белого шума (-1..1) - корень из трети; полосовой оставляет долю полосы
  // `пи * центр / (2 Q)` от половины частоты дискретизации.
  const rms = Math.sqrt(1 / 3) * Math.sqrt((Math.PI * HISS.center) / (2 * HISS.q) / (ctx.sampleRate / 2))
  loop(ctx, white, Math.random() * (white.duration - 0.1))
    .connect(band)
    .connect(gain(ctx, db(LEVEL.radio.db) / rms))
    .connect(sh.input)
  const at = placed(sh, { rooms: [SOURCES.receiver.room], at: SOURCES.receiver, ref: LEVEL.radio.ref })
  let pattern: string | null = null
  let whistleIn = rand(EVERY.whistle[0] * 0.5, EVERY.whistle[1])
  let callIn = rand(EVERY.call[0], EVERY.call[1])

  /** Свист гетеродина: тон уплывает сверху вниз и обратно, пока станция проходит мимо. */
  function whistle(): void {
    const t = ctx.currentTime + 0.02
    const dur = rand(1.2, 2.6)
    const osc = ctx.createOscillator()
    osc.frequency.setValueAtTime(rand(2200, 3200), t)
    osc.frequency.exponentialRampToValueAtTime(rand(350, 600), t + dur * 0.55)
    osc.frequency.exponentialRampToValueAtTime(rand(900, 1600), t + dur)
    const a = db(LEVEL.radio.db - 8) * Math.SQRT2
    const g = gain(ctx, 0)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(a, t + 0.3)
    g.gain.setValueAtTime(a, t + dur - 0.4)
    g.gain.linearRampToValueAtTime(0, t + dur)
    osc.connect(g).connect(sh.input)
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  /** Позывной: свой генератор и своя огибающая на каждую передачу - очередь автоматизаций не копится. */
  function transmit(p: string): void {
    const marks = morse(p)
    if (!marks.length) return
    const u = MORSE.unit
    const t0 = ctx.currentTime + 0.05
    const a = db(LEVEL.radio.db + 6) * Math.SQRT2
    const osc = ctx.createOscillator()
    osc.frequency.value = MORSE.tone
    const g = gain(ctx, 0)
    for (const [on, off] of marks) {
      g.gain.setValueAtTime(0, t0 + on * u)
      g.gain.linearRampToValueAtTime(a, t0 + on * u + 0.004)
      g.gain.setValueAtTime(a, t0 + off * u - 0.004)
      g.gain.linearRampToValueAtTime(0, t0 + off * u)
    }
    osc.connect(g).connect(sh.input)
    osc.start(t0)
    osc.stop(t0 + marks[marks.length - 1][1] * u + 0.05)
  }

  return {
    inside: true,
    place: at.place,
    tick(dt) {
      whistleIn -= dt
      if (whistleIn <= 0) {
        whistleIn = rand(EVERY.whistle[0], EVERY.whistle[1])
        if (at.heard >= AUDIBLE) whistle()
      }
      if (!pattern) return
      callIn -= dt
      if (callIn <= 0) {
        callIn = rand(EVERY.call[0], EVERY.call[1])
        if (at.heard >= AUDIBLE) transmit(pattern)
      }
    },
    callsign(p) {
      pattern = p && p.trim() ? p : null
    },
  }
}

function consoleHum(rig: Rig): Layer | null {
  const { mix, bank } = rig
  const ctx = mix.ctx
  const hum = bank.buffer(ctx, 'hum')
  if (!hum) return null
  const sh = new Shaded(mix)
  loop(ctx, hum, Math.random() * HUM_SECONDS, 1.0007)
    .connect(gain(ctx, db(LEVEL.console.db) / LOOP_RMS))
    .connect(sh.input)
  if (LINE_HZ < ctx.sampleRate * 0.45) {
    const screen = ctx.createOscillator()
    screen.frequency.value = LINE_HZ
    screen.connect(gain(ctx, db(LEVEL.screen.db) * Math.SQRT2)).connect(sh.input)
    screen.start()
  }
  const at = placed(sh, { rooms: ['F'], at: CONSOLE, ref: LEVEL.console.ref })
  return { inside: true, place: at.place }
}

/** Капель в одну точку: ведро, раковина. */
function leak(
  rig: Rig,
  where: Point & { room: RoomId },
  lv: { db: number; ref: number },
  every: readonly [number, number],
  pitch: readonly [number, number],
  kind: 'drops' | 'bucket'
): Layer {
  const { mix, synth } = rig
  const sh = new Shaded(mix)
  const at = placed(sh, { rooms: [where.room], at: where, ref: lv.ref })
  let left = rand(0.3, every[1])
  return {
    inside: true,
    place: at.place,
    tick(dt) {
      left -= dt
      if (left > 0) return
      left = rand(every[0], every[1])
      if (at.heard >= AUDIBLE) synth.dropInto(sh.input, db(lv.db), rand(pitch[0], pitch[1]), kind)
    },
  }
}

/** RMS коричневого шума банка (0.5) под срезом 250 Гц: у него почти вся энергия ниже. */
const BROWN_LOW = 0.48

function cold(rig: Rig): Layer | null {
  const { mix, bank } = rig
  const ctx = mix.ctx
  const hum = bank.buffer(ctx, 'hum')
  const brown = bank.buffer(ctx, 'brown')
  if (!hum || !brown) return null
  const sh = new Shaded(mix)
  const lv = db(LEVEL.cold.db)
  // Компрессор: тот же гул дросселя октавой ниже - 50 Гц с гармониками.
  loop(ctx, hum, Math.random() * HUM_SECONDS, 0.5).connect(gain(ctx, (lv * 0.8) / LOOP_RMS)).connect(sh.input)
  // Вентилятор и сам холод: коричневый шум под срезом 250 Гц. Доли 0.8 и 0.6 - по мощности вместе единица.
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 250
  lp.Q.value = qOf('lowpass', Math.SQRT1_2)
  loop(ctx, brown, Math.random() * brown.duration).connect(lp).connect(gain(ctx, (lv * 0.6) / BROWN_LOW)).connect(sh.input)
  const at = placed(sh, { rooms: [COLD.room], at: { x: COLD.x, y: COLD.y, z: COLD.z }, ref: LEVEL.cold.ref })
  return { inside: true, place: at.place }
}

/** Капель по всему нижнему ярусу: в воду, в случайных местах. Заводится, только когда ухо рядом. */
function drips(rig: Rig): Layer {
  const { inside } = rig
  let zone: ZoneId = 'out'
  let left = rand(0.5, EVERY.drip[1])
  const room = ROOMS.I
  return {
    inside: true,
    place(_ear, _how, h) {
      zone = h.zone
    },
    tick(dt) {
      left -= dt
      if (left > 0) return
      left = rand(EVERY.drip[0], EVERY.drip[1])
      if (zone !== 'I' && zone !== 'J' && zone !== 'F') return
      const p = { x: rand(room.x0 + 0.3, room.x1 - 0.3), y: room.floor + LOWER.water, z: rand(room.z0 + 0.3, room.z1 - 0.3) }
      inside.dropAt(p, LEVEL.drip, rand(0.8, 1.1))
    },
  }
}

/** Стоны корпуса: редко, из-под пола слышно и наверху - глухо. С улицы не слышно вовсе. */
function groans(rig: Rig): Layer {
  const { inside } = rig
  let zone: ZoneId = 'out'
  let left = rand(15, 40)
  return {
    inside: true,
    place(_ear, _how, h) {
      zone = h.zone
    },
    tick(dt) {
      left -= dt
      if (left > 0) return
      left = rand(EVERY.groan[0], EVERY.groan[1])
      if (zone !== 'out') inside.groan()
    },
  }
}

/** Собрать слой нутра. Пусто, если нужное ему ещё не посчитано. */
export function makeIndoor(name: IndoorName, rig: Rig): Layer | null {
  if (name.startsWith('tube:')) return tube(fixture(name.slice(5) as FixtureId), rig)
  switch (name) {
    case 'generator':
      return generator(rig)
    case 'roof':
      return roof(rig, false)
    case 'roofBlock':
      return roof(rig, true)
    case 'clock':
      return steady(rig, 'clock', SOURCES.clock, LEVEL.clock, true)
    case 'pump':
      return steady(rig, 'pump', SOURCES.pump, LEVEL.pump, false)
    case 'receiver':
      return receiver(rig)
    case 'console':
      return consoleHum(rig)
    case 'bucket':
      return leak(rig, SOURCES.bucket, LEVEL.bucket, EVERY.leak, [0.95, 1.05], 'bucket')
    case 'sink':
      return leak(rig, SOURCES.labSink, LEVEL.sink, EVERY.sink, [1.3, 1.6], 'drops')
    case 'cold':
      return cold(rig)
    case 'drips':
      return drips(rig)
    case 'groans':
      return groans(rig)
  }
  return null
}
