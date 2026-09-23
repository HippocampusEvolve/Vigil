/**
 * sound/outdoor.ts - поляна: постоянные слои и редкие события.
 *
 * Базовое состояние - ровный дождь и гул; напряжение строится тем, что из
 * смеси уходит. Поэтому постоянных слоёв много, а событий мало: одиноко -
 * значит редко.
 *
 * Постоянные слои, у каждого своё место из раскладки мира (`world/layout.ts`),
 * копий чисел здесь нет:
 *   дождь по листьям    густой, везде одинаковый, мимо свёртки;
 *   дождь по бетону     крыша поста, отмостка и лужи у стен: слышен тем
 *                       громче, чем ближе стены и навес;
 *   завеса капель       с передней кромки навеса;
 *   водосток            струя из оторванной трубы в лужу: коричневый шум через
 *                       полосовой 300-1200 Гц, центр гуляет медленным шумом,
 *                       громкость дрожит;
 *   лампа               гудит от сети 50 Гц: основа 100 Гц и гармоники 200,
 *                       300, 400 со спадом, у каждой своя дрожь и расстройка
 *                       на центы, лёгкое насыщение;
 *   насекомые           прямоугольник 4-6 кГц с дрожью громкости 30-50 Гц на
 *                       каждого певца, двенадцать певцов по опушке, общая
 *                       медленная волна 4-8 с; обрываются по действию;
 *   ручей               вдоль западного края;
 *   генератор           глухо из-за стены: снаружи срез 300 Гц и -12 дБ. Он
 *                       живёт в генераторной и слышен по графу зон, как всё
 *                       нутро (`indoor.ts`), но в списке поляны остаётся: с
 *                       поляны его слышно.
 * Редкие: скрип стволов, плоды, далёкая птица раз в 45-90 с. Гром приходит
 * только по вызову.
 *
 * Все слои поляны звучат в шины улицы (`shade.ts`), а не прямо в микшер:
 * изнутри поста улица слышна через дверь или стену одним общим затенением, и
 * слои ставятся не по настоящему уху, а по уху у того проёма или стены,
 * откуда улица слышна.
 */

import { BLOCK, CANOPY, CLEARING, ENTRY_LAMP, GUTTER, HANGAR, PLINTH, STREAM } from '../world/layout'
import type { Bank } from './bank'
import { db, LOOP_RMS, rng } from './dsp'
import type { Hearing } from './hear'
import { LEVEL } from './levels'
import { HUM } from './machines'
import type { Bus } from './mixer'
import { alongX, alongZ, distance, falloff, nearestInRect, panOf, Spot, type Ear, type How, type Point } from './place'
import type { Synth } from './synth'

export type { How } from './place'

/** Слои самой поляны. Генератор слышен с поляны, но живёт в нутре (`indoor.ts`). */
export type OutdoorName = 'rainLeaves' | 'rainConcrete' | 'curtain' | 'gutter' | 'lamp' | 'insects' | 'stream'

/** Всё, что слышно на поляне, в порядке подключения: сперва то, что слышно из точки появления. */
export const OUTDOOR = ['rainLeaves', 'insects', 'lamp', 'generator', 'gutter', 'curtain', 'rainConcrete', 'stream'] as const satisfies ReadonlyArray<
  OutdoorName | 'generator'
>

export interface Layer {
  /**
   * Поставить слой по уху. Слои поляны берут ухо у проёма или стены, откуда
   * слышна улица; слои нутра - настоящее ухо и граф зон (`h`).
   */
  place(ear: Ear, how: How, h: Hearing): void
  /** Живёт внутри: ставится по настоящему уху и по графу зон. */
  inside?: boolean
  /** Обрыв (есть только у насекомых): см. `cut` ниже. */
  cut?(at: number): void
  /** Часы кадра: у слоёв с редкими событиями. */
  tick?(dt: number): void
  /** Сила света 0..1: у трубок гул идёт за ней. */
  light?(power: number): void
  /** Позывной в эфире (у приёмника). */
  callsign?(pattern: string | null): void
}

/** Общее для всех слоёв: сила дождя 0..1. От неё зависят и лужи, и завеса, и водосток. */
export type Weather = { rain: number }

/**
 * Точки источников, выведенные из раскладки: откуда звучит струя водостока,
 * по какой линии течёт ручей, на какой высоте бьёт завеса. Их же берёт
 * проверка звука, чтобы ставить ухо ровно на опорное расстояние.
 */
export const WHERE = {
  /** Струя бьёт в лужу под оторванной трубой. */
  gutter: { x: GUTTER.x, y: 0.2, z: GUTTER.z },
  /** Ручей: вода по дну промоины, посередине её ширины. */
  stream: { x: (STREAM.x0 + STREAM.x1) / 2, y: -STREAM.depth + 0.1 },
  /** Завеса бьёт в отмостку под передней кромкой навеса. */
  curtain: { y: PLINTH.top, z: CANOPY.z1 },
} as const

/** Здание в плане: входной блок и ангар одним прямоугольником, навес с отмосткой - вторым. */
const POST = { x0: HANGAR.x0, x1: BLOCK.x1, z0: Math.min(HANGAR.z0, BLOCK.z0), z1: Math.max(HANGAR.z1, BLOCK.z1) }
const FRONT = { x0: Math.min(CANOPY.x0, PLINTH.x0), x1: CANOPY.x1, z0: CANOPY.z0, z1: CANOPY.z1 }

/** Звук петли по кругу, с места `offset` секунд. */
export function loop(ctx: BaseAudioContext, buffer: AudioBuffer, offset = 0, rate = 1): AudioBufferSourceNode {
  const s = ctx.createBufferSource()
  s.buffer = buffer
  s.loop = true
  s.playbackRate.value = rate
  s.start(0, offset % buffer.duration)
  return s
}

export function gain(ctx: BaseAudioContext, v: number): GainNode {
  const g = ctx.createGain()
  g.gain.value = v
  return g
}

/**
 * Стерео из двух моно-петель разной длины. Каналы слегка перетекают друг в
 * друга: совсем порознь дождь звучит двумя дождями по бокам головы.
 */
export function stereoLoop(ctx: BaseAudioContext, left: AudioBuffer, right: AudioBuffer, rate = 1): { out: AudioNode; rms: number } {
  const bleed = 0.35
  const merger = ctx.createChannelMerger(2)
  const l = loop(ctx, left, 0, rate)
  const r = loop(ctx, right, 0, rate)
  l.connect(gain(ctx, 1)).connect(merger, 0, 0)
  l.connect(gain(ctx, bleed)).connect(merger, 0, 1)
  r.connect(gain(ctx, 1)).connect(merger, 0, 1)
  r.connect(gain(ctx, bleed)).connect(merger, 0, 0)
  return { out: merger, rms: LOOP_RMS * Math.hypot(1, bleed) }
}

// --- Слои ------------------------------------------------------------------------

function rainLeaves(mix: Bus, bank: Bank, weather: Weather): Layer | null {
  const ctx = mix.ctx
  const l = bank.buffer(ctx, 'leavesL')
  const r = bank.buffer(ctx, 'leavesR')
  if (!l || !r) return null
  const { out, rms } = stereoLoop(ctx, l, r)
  const level = gain(ctx, 0)
  out.connect(level).connect(mix.weather)
  const base = db(LEVEL.rain) / rms
  let written = -1
  return {
    place(_ear, how) {
      const v = base * weather.rain
      if (v === written && how === 'glide') return
      written = v
      const t = ctx.currentTime
      if (how === 'now') level.gain.setValueAtTime(v, t)
      else level.gain.setTargetAtTime(v, t, how === 'fade' ? 0.6 : 1.5)
    },
  }
}

function rainConcrete(mix: Bus, bank: Bank, weather: Weather): Layer | null {
  const ctx = mix.ctx
  const l = bank.buffer(ctx, 'concreteL')
  const r = bank.buffer(ctx, 'concreteR')
  if (!l || !r) return null
  const { out, rms } = stereoLoop(ctx, l, r)
  const spot = new Spot(mix, { out: mix.weather, wet: 0, stereo: true })
  out.connect(spot.input)
  const base = db(LEVEL.rainConcrete.db) / rms
  const ref = LEVEL.rainConcrete.ref
  return {
    place(ear, how) {
      const a = nearestInRect(ear, POST, 0)
      const b = nearestInRect(ear, FRONT, 0)
      const p = distance(ear, a) < distance(ear, b) ? a : b
      const d = Math.hypot(p.x - ear.x, p.z - ear.z)
      // Площадь, а не точка: вблизи дождь по бетону со всех сторон, панорамы нет.
      spot.set(base * weather.rain * falloff(d, ref), panOf(ear, p) * 0.6 * Math.min(1, d / 5), how)
    },
  }
}

function curtain(mix: Bus, bank: Bank, weather: Weather): Layer | null {
  const ctx = mix.ctx
  const buf = bank.buffer(ctx, 'curtain')
  if (!buf) return null
  const spot = new Spot(mix)
  loop(ctx, buf).connect(spot.input)
  const base = db(LEVEL.curtain.db) / LOOP_RMS
  return {
    place(ear, how) {
      const p = alongX(ear, CANOPY.x0, CANOPY.x1, WHERE.curtain.y, WHERE.curtain.z)
      spot.set(base * weather.rain * falloff(distance(ear, p), LEVEL.curtain.ref), panOf(ear, p), how)
    },
  }
}

/**
 * RMS струи до усиления: коричневый шум (RMS 0.5) после полосового около
 * 650 Гц сохраняет около пятой части амплитуды. Снято счётом.
 */
const GUTTER_RMS = 0.116

function gutter(mix: Bus, bank: Bank, weather: Weather): Layer | null {
  const ctx = mix.ctx
  const brown = bank.buffer(ctx, 'brown')
  const wander = bank.buffer(ctx, 'wander')
  if (!brown || !wander) return null
  const spot = new Spot(mix)
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 650
  band.Q.value = 1.1
  // Центр гуляет 370-930 Гц медленным шумом, громкость дрожит быстрее.
  loop(ctx, wander, 3, 0.35).connect(gain(ctx, 280)).connect(band.frequency)
  const tremble = gain(ctx, 0.75)
  loop(ctx, wander, 11, 3.1).connect(gain(ctx, 0.25)).connect(tremble.gain)
  loop(ctx, brown, 1.3).connect(band).connect(tremble).connect(spot.input)
  const base = db(LEVEL.gutter.db) / (GUTTER_RMS * 0.75)
  const at: Point = WHERE.gutter
  return {
    place(ear, how) {
      spot.set(base * weather.rain * falloff(distance(ear, at), LEVEL.gutter.ref), panOf(ear, at), how)
    },
  }
}

/** Гармоники гула лампы - те же, что у трубок нутра (`machines.ts`). */
function lamp(mix: Bus): Layer {
  const ctx = mix.ctx
  const spot = new Spot(mix)
  const sum = gain(ctx, 0.5)
  for (const [k, a] of HUM) {
    const osc = ctx.createOscillator()
    osc.frequency.value = 100 * k
    osc.detune.value = (Math.random() * 2 - 1) * 4
    // Своя медленная дрожь: высота на пару центов, громкость на десятую долю.
    const pitch = ctx.createOscillator()
    pitch.frequency.value = 0.07 + Math.random() * 0.25
    pitch.connect(gain(ctx, 1.5 + Math.random() * 1.5)).connect(osc.detune)
    const amp = gain(ctx, a)
    const breath = ctx.createOscillator()
    breath.frequency.value = 0.05 + Math.random() * 0.15
    breath.connect(gain(ctx, a * 0.12)).connect(amp.gain)
    osc.connect(amp).connect(sum)
    for (const o of [osc, pitch, breath]) o.start()
  }
  // Лёгкое насыщение: дроссель гудит не чистыми синусами. Наклон кривой в нуле -
  // единица: тихое проходит как есть, гнутся только гребни волны.
  const shaper = ctx.createWaveShaper()
  const curve = new Float32Array(1025)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(1.4 * x) / 1.4
  }
  shaper.curve = curve
  // RMS суммы гармоник; насыщение гнёт гребни и отнимает около 1 дБ (снято счётом).
  const rms = 0.5 * Math.sqrt(HUM.reduce((s, [, a]) => s + (a * a) / 2, 0)) * 0.89
  const level = gain(ctx, db(LEVEL.lamp.db) / rms)
  sum.connect(shaper).connect(level).connect(spot.input)
  return {
    place(ear, how) {
      const p = alongX(ear, ENTRY_LAMP.x0, ENTRY_LAMP.x1, ENTRY_LAMP.y, ENTRY_LAMP.z)
      spot.set(falloff(distance(ear, p), LEVEL.lamp.ref), panOf(ear, p), how)
    },
  }
}

/** Сколько певцов и где их опора, м. */
const SINGERS = 12
const SINGER_REF = 3
/**
 * RMS одного певца: прямоугольник (RMS около 1) под дрожью 0..1 (RMS 0.61) и
 * под общей волной 0.65 +- 0.35 (RMS 0.70). Уровень хора меряется за целый
 * оборот волны: за три секунды он гуляет на пару децибел.
 */
const SINGER_RMS = 0.61 * 0.7

/** Точка на опушке: сторона поляны по её длине, отступ `inset` внутрь (минус - в лес). */
export function edgePoint(r: () => number, inset: number): Point {
  const w = CLEARING.maxX - CLEARING.minX
  const h = CLEARING.maxZ - CLEARING.minZ
  let s = r() * 2 * (w + h)
  let x: number
  let z: number
  if (s < w) {
    x = CLEARING.minX + s
    z = CLEARING.minZ + inset
  } else if ((s -= w) < h) {
    x = CLEARING.maxX - inset
    z = CLEARING.minZ + s
  } else if ((s -= h) < w) {
    x = CLEARING.maxX - s
    z = CLEARING.maxZ - inset
  } else {
    s -= w
    x = CLEARING.minX + inset
    z = CLEARING.maxZ - s
  }
  return { x, y: 0.4, z }
}

function insects(mix: Bus): Layer {
  const ctx = mix.ctx
  const bus = gain(ctx, 1)
  // Общая медленная волна: хор то набирает, то отпускает.
  const wave = gain(ctx, 0.65)
  const swell = ctx.createOscillator()
  swell.frequency.value = 1 / (4 + Math.random() * 4)
  swell.connect(gain(ctx, 0.35)).connect(wave.gain)
  swell.start()
  const cutter = gain(ctx, 1)
  bus.connect(wave).connect(cutter).connect(mix.sfx)

  const r = rng(71)
  const singers: Array<{ at: Point; weight: number; spot: Spot }> = []
  for (let i = 0; i < SINGERS; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 4000 + r() * 2000
    const am = gain(ctx, 0.5)
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 30 + r() * 20
    lfo.connect(gain(ctx, 0.5)).connect(am.gain)
    const spot = new Spot(mix, { out: bus, wet: 0 })
    osc.connect(am).connect(spot.input)
    osc.start()
    lfo.start()
    singers.push({ at: edgePoint(r, -3 + r() * 9), weight: 0.6 + r() * 0.4, spot })
  }

  // Конец последнего обрыва: пока он идёт, уровень шины считается по его кривой.
  let cutAt = -Infinity
  const DOWN = 0.3
  const BACK = 6
  const FLOOR = db(-40)
  const valueAt = (t: number): number => {
    const dt = t - cutAt
    if (dt < 0 || dt >= DOWN + BACK) return 1
    if (dt < DOWN) return Math.pow(FLOOR, dt / DOWN)
    return Math.pow(FLOOR, 1 - (dt - DOWN) / BACK)
  }

  return {
    place(ear, how) {
      // Хор нормируется целиком: где бы ни стоял слушатель, насекомых -30 дБ,
      // а расстояния решают только, кто из певцов ближе и с какой стороны.
      let sum = 0
      const w = singers.map((s) => {
        const v = s.weight * falloff(distance(ear, s.at), SINGER_REF)
        sum += v * v
        return v
      })
      const norm = db(LEVEL.insects) / SINGER_RMS / Math.sqrt(sum)
      singers.forEach((s, i) => s.spot.set(w[i] * norm, panOf(ear, s.at), how))
    },
    /**
     * Обрыв: шина падает на 40 дБ за 0.3 с и возвращается за 6 с. Насекомые
     * обрываются - уровень шины за 500 мс после действия падает на 30 дБ и
     * больше.
     */
    cut(at) {
      const g = cutter.gain
      const from = valueAt(at)
      g.cancelScheduledValues(at)
      g.setValueAtTime(from, at)
      g.exponentialRampToValueAtTime(FLOOR, at + DOWN)
      g.exponentialRampToValueAtTime(1, at + DOWN + BACK)
      cutAt = at
    },
  }
}

function stream(mix: Bus, bank: Bank): Layer | null {
  const ctx = mix.ctx
  const buf = bank.buffer(ctx, 'stream')
  if (!buf) return null
  const spot = new Spot(mix)
  loop(ctx, buf).connect(spot.input)
  const base = db(LEVEL.stream.db) / LOOP_RMS
  return {
    place(ear, how) {
      const p = alongZ(ear, WHERE.stream.x, WHERE.stream.y, STREAM.z0, STREAM.z1)
      spot.set(base * falloff(distance(ear, p), LEVEL.stream.ref), panOf(ear, p), how)
    },
  }
}

/** Собрать слой. Пусто, если нужное ему ещё не посчитано: тогда попробуем в следующем кадре. */
export function makeLayer(name: OutdoorName, mix: Bus, bank: Bank, weather: Weather): Layer | null {
  switch (name) {
    case 'rainLeaves':
      return rainLeaves(mix, bank, weather)
    case 'rainConcrete':
      return rainConcrete(mix, bank, weather)
    case 'curtain':
      return curtain(mix, bank, weather)
    case 'gutter':
      return gutter(mix, bank, weather)
    case 'lamp':
      return lamp(mix)
    case 'insects':
      return insects(mix)
    case 'stream':
      return stream(mix, bank)
  }
}

// --- Редкие события -------------------------------------------------------------

/** Сколько секунд между событиями: [от, до]. Густота низкая всю игру. */
export const RARE = {
  bird: [45, 90],
  creak: [30, 80],
  fruit: [25, 60],
} as const

/**
 * Часы редких событий. Идут по `dt` кадра, а не по таймерам: свернули вкладку -
 * часы стоят вместе с миром.
 */
export function createRare(synth: Synth) {
  const r = Math.random
  const next = (k: keyof typeof RARE) => RARE[k][0] + (RARE[k][1] - RARE[k][0]) * r()
  // Первые события приходят не сразу: игрок только встаёт.
  const left = { bird: next('bird') * 0.6, creak: next('creak'), fruit: next('fruit') }
  return {
    tick(dt: number): void {
      left.bird -= dt
      left.creak -= dt
      left.fruit -= dt
      if (left.bird <= 0) {
        left.bird = next('bird')
        // Птица далеко, в глубине леса за опушкой.
        synth.bird(edgePoint(r, -(12 + 25 * r())))
      }
      if (left.creak <= 0) {
        left.creak = next('creak')
        const p = edgePoint(r, -(1 + 4 * r()))
        synth.creak({ ...p, y: 3 + 6 * r() })
      }
      if (left.fruit <= 0) {
        left.fruit = next('fruit')
        synth.fruit(edgePoint(r, 2 * r()))
      }
    },
  }
}

/** Где ухо, пока про него ничего не сказали: точка появления, взгляд на лампу. */
export function defaultEar(wake: { x: number; z: number }, eye: number): Ear {
  const lx = (ENTRY_LAMP.x0 + ENTRY_LAMP.x1) / 2 - wake.x
  const lz = ENTRY_LAMP.z - wake.z
  const n = Math.hypot(lx, lz) || 1
  return { x: wake.x, y: eye, z: wake.z, fx: lx / n, fy: 0, fz: lz / n }
}

