/**
 * sound/inside.ts - разовые звуки нутра: двери, стоны корпуса, капель, вздох
 * порога, щелчки стартёров.
 *
 * Каждый звук ставится туда, где он случился, и слышен по графу зон
 * (`hear.ts`): дверь - в своём проёме, и из той комнаты, куда она открыта,
 * она звучит в полную полосу, а из-за стены - глухо. Сам звук считается в
 * массив (`strike.ts`) и приводится к пику 1, поэтому его уровень из `LEVEL` -
 * ровно пик на опорном расстоянии; стоны корпуса, самые долгие, посчитаны
 * заранее набором. Узлы создаются на событие и отпускаются.
 *
 * Дверь:
 *   'unlock'  лязг замка;
 *   'open'    скрип открывающейся створки, `speed` - её скорость, рад/с;
 *   'close'   скрип закрывающейся, чуть ниже;
 *   'shut'    удар створки о коробку и щелчок защёлки.
 *
 * «Вздох» порога - синус 40-60 Гц под колоколом 150 мс, сухо и посередине
 * головы: это давление в ушах, а не звук в комнате.
 */

import { LOWER } from '../world/layout'
import { PORTALS, portalCenter, ROOMS, zoneAt, type DoorId, type RoomId } from '../world/zones'
import type { Bank } from './bank'
import { db } from './dsp'
import { hear, SIGH, type Hearing, type Source } from './hear'
import { LEVEL, SEND } from './levels'
import type { Mixer } from './mixer'
import type { Point } from './place'
import { Shaded } from './shade'
import { DOOR_VOICE, GROAN, renderCreak, renderLock, renderSlam, renderStarter } from './strike'
import type { Synth } from './synth'

const rand = (a: number, b: number): number => a + (b - a) * Math.random()

export type DoorEvent = 'unlock' | 'open' | 'close' | 'shut'

/** Скорость створки, если про неё ничего не сказали, рад/с: спокойная рука. */
export const DOOR_SPEED = 1.2

/** Где звучит дверь: середина её проёма, слышна из обеих комнат по сторонам. */
const DOORS = new Map<DoorId, Source>(
  PORTALS.flatMap((p) => (p.door ? [[p.door, { rooms: [p.a, p.b], at: portalCenter(p), ref: LEVEL.door.ref }] as const] : []))
)

export type Inside = ReturnType<typeof createInside>

export function createInside(mix: Mixer, h: Hearing, synth: Synth, bank: Bank, opts: { wet?: number } = {}) {
  const ctx = mix.ctx

  /** Источник в точке, поставленный по графу сейчас. */
  function shadedAt(src: Source, wet: number): Shaded {
    const s = new Shaded(mix, { wet: opts.wet ?? wet })
    s.set(hear(src, h.ear, h.zone, h.doors), h.ear, 'now')
    return s
  }

  /** Сыграть посчитанный массив в узел; `rate` - частота, на которой он посчитан. */
  function play(data: Float32Array, out: AudioNode, t: number, gain: number, rate = ctx.sampleRate): void {
    const b = ctx.createBuffer(1, data.length, rate)
    b.copyToChannel(data as Float32Array<ArrayBuffer>, 0)
    const s = ctx.createBufferSource()
    s.buffer = b
    const g = ctx.createGain()
    g.gain.value = gain
    s.connect(g).connect(out)
    s.start(t)
  }

  function door(id: DoorId, kind: DoorEvent, speed = DOOR_SPEED): void {
    const src = DOORS.get(id)
    if (!src) return
    const s = shadedAt(src, SEND.near)
    const voice = DOOR_VOICE[id]
    const t = ctx.currentTime + 0.005
    const rate = ctx.sampleRate
    if (kind === 'unlock') play(renderLock(rate, voice), s.input, t, db(LEVEL.door.db))
    else if (kind === 'shut') play(renderSlam(rate, voice), s.input, t, db(LEVEL.door.db))
    // Скрип считается на половинной частоте: его резонансы ниже 3 кГц, щелчкам
    // срыва хватает верха до 11-12 кГц, а счёт в миг события вдвое короче.
    else play(renderCreak(rate / 2, speed, kind === 'close', voice), s.input, t, db(LEVEL.hinge.db), rate / 2)
  }

  /** Случайная точка у стены нижнего яруса, на высоте груди: корпус стонет стенами. */
  function hullPoint(): Point {
    const room = ROOMS[Math.random() < 0.7 ? 'I' : 'J']
    const side = Math.random() < 0.5
    const x = side ? (Math.random() < 0.5 ? room.x0 : room.x1) : rand(room.x0, room.x1)
    const z = side ? rand(room.z0, room.z1) : Math.random() < 0.5 ? room.z0 : room.z1
    return { x, y: LOWER.floor + rand(0.5, 2), z }
  }

  /** Зона точки: для точки на самой грани стены - комната, чьей гранью она служит. */
  function roomOf(p: Point): RoomId | null {
    const z = zoneAt(p.x, p.y, p.z)
    return z === 'out' ? null : z
  }

  return {
    door,

    /**
     * Стон корпуса: в точке `p` или у случайной стены низа; через отклик
     * пространства - большой посыл. Один из посчитанных заранее (`bank.ts`),
     * со своей скоростью: у каждого раза своя высота.
     */
    groan(p: Point = hullPoint()): void {
      const set = bank.audio(ctx, 'groans')
      const room = roomOf(p)
      if (!set || !room) return
      const s = shadedAt({ rooms: [room], at: p, ref: LEVEL.groan.ref }, SEND.far)
      const src = ctx.createBufferSource()
      src.buffer = set[Math.floor(Math.random() * set.length)]
      src.playbackRate.value = rand(GROAN.play[0], GROAN.play[1])
      const g = ctx.createGain()
      g.gain.value = db(LEVEL.groan.db)
      src.connect(g).connect(s.input)
      src.start(ctx.currentTime + 0.01)
    },

    /** Капля в точке `p` (в воду низа, в раковину): из набора `kind`, с уровнем `level` на его опоре. */
    dropAt(p: Point, level: { db: number; ref: number }, rate = 1, kind: 'drops' | 'bucket' = 'drops'): void {
      const room = roomOf(p)
      if (!room) return
      const s = shadedAt({ rooms: [room], at: p, ref: level.ref }, SEND.near)
      synth.dropInto(s.input, db(level.db), rate, kind)
    },

    /**
     * «Вздох» давления, начиная с `at` по часам контекста: синус 40-60 Гц,
     * чуть проседающий, под колоколом `SIGH.dur`. Сухо, мимо пространства.
     */
    sigh(at = ctx.currentTime): void {
      const t = Math.max(at, ctx.currentTime)
      // Проседает на восьмую долю - и к концу всё ещё не ниже 40 Гц.
      const sag = 0.88
      const f = rand(SIGH.lo / sag + 1, SIGH.hi - 5)
      const osc = ctx.createOscillator()
      osc.frequency.setValueAtTime(f, t)
      osc.frequency.exponentialRampToValueAtTime(f * sag, t + SIGH.dur)
      const bell = new Float32Array(64)
      for (let i = 0; i < bell.length; i++) bell[i] = db(LEVEL.sigh) * Math.pow(Math.sin((Math.PI * i) / (bell.length - 1)), 2)
      const g = ctx.createGain()
      g.gain.value = 0
      g.gain.setValueCurveAtTime(bell, t, SIGH.dur)
      osc.connect(g).connect(mix.dry)
      osc.start(t)
      osc.stop(t + SIGH.dur + 0.02)
    },

    /** Щелчок стартёра или «тинк» зажигания - в узел трубки, уже затенённый по её месту. */
    starter(out: AudioNode, kind: 'click' | 'tink', gain: number): void {
      play(renderStarter(ctx.sampleRate, kind), out, ctx.currentTime + 0.002, gain)
    },
  }
}
