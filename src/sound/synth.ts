/**
 * sound/synth.ts - разовые звуки поляны. Узлы создаются на каждый звук и
 * отпускаются, как только источники отзвучали: копить граф незачем.
 *
 * Что как звучит и почему:
 *   ШАГ ПО ГРЯЗИ   низкий удар (шум под срезом 300-600 Гц, 80-150 мс) и чавк -
 *                  полосовой, скользящий 200-800 Гц за 60-120 мс. Грязь
 *                  принимает ногу мягко: атака не меньше 8 мс, громче всего
 *                  чавк, а не удар.
 *   ШАГ ПО БЕТОНУ  щелчок, полоса 1-4 кГц, спад 40-80 мс, тонкий звон около
 *                  2.5 кГц. Бетон звонче грязи: яркость выше в полтора с
 *                  лишним раза, атака не больше 3 мс.
 *   ШАГ ПО ВОДЕ    шаг по бетону плюс всплеск: вода брызжет, энергии выше
 *                  4 кГц вдвое больше, чем у шага по грязи.
 *   ШАГ ПО МАРШУ   посчитанный заранее набор (`strike.ts`): щелчок, три моды
 *                  800-3000 Гц со спадом 60-150 мс и дребезг проступи через
 *                  10-20 мс.
 *   МОКРЫЕ ПОДОШВЫ после грязи или воды первые 30 шагов по твёрдому - с лёгким
 *                  «чваком»: полоса, скользящая 300-1200 Гц за 40-70 мс, всё
 *                  тише от шага к шагу. Энергии в полосе чвака у первого шага
 *                  вдвое больше, чем у сухого.
 *   ВСПЛЕСК        щелчок шума 5-10 мс, за ним 3-8 капель с задержками до
 *                  40 мс, низкий удар 80-150 Гц.
 *   ДАЛЁКИЙ ГРОМ   коричневый шум под срезом, который ползёт от 200 к 60 Гц;
 *                  огибающая горбами, 3.5-8 с; две-три копии с задержками
 *                  0.1-0.6 с; через отклик леса. Длинный и низкий: звучит не
 *                  меньше 3 с, центроид ниже 300 Гц.
 *   БЛИЗКИЙ УДАР   треск - белый шум со срезом снизу, атака меньше 5 мс, спад
 *                  80-150 мс; удар - полоса 80-200 Гц на 0.4-0.8 с; сразу за
 *                  ним далёкий раскат. Резкий: атака не больше 5 мс.
 *   ДАЛЁКАЯ ПТИЦА  шум через узкий полосовой, высота скользит 800-1500-600 Гц
 *                  за 0.3-0.6 с, больше отражений, чем прямого звука.
 *   СКРИП СТВОЛА   пила низкой частоты - каждый её скачок это «срыв» волокна -
 *                  через три узких резонанса 350-900 Гц.
 *   ПЛОД           шорох сквозь листья, потом глухой удар о землю.
 *   КАПЛЯ          одна из заранее посчитанных капель (`water.ts`); капля в
 *                  ведро - из своего набора, ниже и глуше, с «бульком».
 *
 * Гром и опушка звучат в шины улицы (`shade.ts`): изнутри поста их слышно
 * через дверь или стену. Шаги - у самого уха, им затенение ни к чему.
 */

import type { Surface } from '../support'
import type { Bank } from './bank'
import { db } from './dsp'
import { LEVEL, SEND } from './levels'
import type { Bus } from './mixer'
import { distance, falloff, panOf, qOf, Spot, type Ear, type Point } from './place'
import { STEEL } from './strike'

const rand = (a: number, b: number): number => a + (b - a) * Math.random()

/**
 * Во сколько раз поднять голос, чтобы его пик вышел около единицы: тогда уровень
 * из `LEVEL` и есть пик на выходе. Числа сняты счётом, на Node без звуковой карты.
 */
const NORM = {
  mud: 5.2,
  concrete: 1.9,
  splash: 1.0,
  far: 0.36,
  boom: 0.2,
  bird: 7.4,
  creak: 1.9,
  fruit: 2.5,
} as const

/** Кривая насыщения треска: всё, что громче четверти, уже почти упёрлось в потолок. */
let crackShape: Float32Array<ArrayBuffer> | null = null
function crackCurve(): Float32Array<ArrayBuffer> {
  if (crackShape) return crackShape
  crackShape = new Float32Array(1025)
  for (let i = 0; i < crackShape.length; i++) {
    const x = (i / (crackShape.length - 1)) * 2 - 1
    crackShape[i] = Math.tanh(4 * x) / Math.tanh(4)
  }
  return crackShape
}

/** Сколько шагов по твёрдому подошвы остаются мокрыми после улицы. */
export const SOLES = 30

/**
 * Мокрые подошвы: грязь и вода мочат их заново, каждый шаг по твёрдому сушит
 * на один шаг. `step` отвечает, сколько «чвака» у этого шага: от 1 у первого
 * до 1/30 у тридцатого, дальше ноль.
 */
export class Soles {
  private left = 0

  step(surface: Surface): number {
    if (surface === 'mud' || surface === 'water') {
      this.left = SOLES
      return 0
    }
    if (this.left <= 0) return 0
    const k = this.left / SOLES
    this.left--
    return k
  }

  /** Намочить, не шагая: игрок вошёл с улицы, а шагов по грязи не было (проверка, перенос). */
  soak(): void {
    this.left = SOLES
  }
}

export type Synth = ReturnType<typeof createSynth>

export function createSynth(mix: Bus, bank: Bank, earOf: () => Ear, opts: { wet?: number; outside?: Bus } = {}) {
  const ctx = mix.ctx
  const street = opts.outside ?? mix
  const soles = new Soles()

  /**
   * Место разового звука: громкость по расстоянию, посыл тем больше, чем
   * дальше. `bus` - в чьи шины: свои или улицы.
   */
  function spot(p: Point, level: number, ref: number, wet?: number, bus: Bus = mix): Spot {
    const ear = earOf()
    const d = distance(ear, p)
    const s = new Spot(bus, { wet: opts.wet ?? wet ?? SEND.near + (SEND.far - SEND.near) * Math.min(1, d / 30) })
    s.set(level * falloff(d, ref), panOf(ear, p, 1.5), 'now')
    return s
  }

  /** Шум со случайного места буфера: два звука подряд не совпадают. */
  function noise(name: 'white' | 'brown', t: number, dur: number): AudioBufferSourceNode | null {
    const buf = bank.buffer(ctx, name)
    if (!buf) return null
    const s = ctx.createBufferSource()
    s.buffer = buf
    s.loop = true
    s.start(t, Math.random() * buf.duration * 0.9)
    s.stop(t + dur + 0.05)
    return s
  }

  /**
   * Фильтр с обычной, линейной добротностью `q`: 0.7 - Баттерворт, без горба
   * у среза. У `BiquadFilterNode` для lowpass и highpass Q задаётся резонансом
   * в децибелах - переводим сами (`qOf`).
   */
  function filter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = qOf(type, q)
    return f
  }

  /** Огибающая «атака линейно, спад экспонентой до тишины к `end`». */
  function envelope(t: number, attack: number, peak: number, end: number): GainNode {
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, Math.max(end, t + attack + 0.005))
    return g
  }

  /** Шумовая пачка через фильтр под огибающей - основа почти всего здесь. */
  function burst(
    out: AudioNode,
    t: number,
    o: { type: BiquadFilterType; freq: number; to?: number; q: number; attack: number; peak: number; end: number; source?: 'white' | 'brown' }
  ): void {
    const src = noise(o.source ?? 'white', t, o.end - t)
    if (!src) return
    const f = filter(o.type, o.freq, o.q)
    if (o.to) {
      f.frequency.setValueAtTime(o.freq, t)
      f.frequency.exponentialRampToValueAtTime(o.to, o.end)
    }
    src.connect(f).connect(envelope(t, o.attack, o.peak, o.end)).connect(out)
  }

  /** Синус со спуском частоты: вес удара, звон. */
  function tone(out: AudioNode, t: number, o: { freq: number; to?: number; attack: number; peak: number; end: number }): void {
    const osc = ctx.createOscillator()
    osc.frequency.setValueAtTime(o.freq, t)
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, o.end)
    osc.connect(envelope(t, o.attack, o.peak, o.end)).connect(out)
    osc.start(t)
    osc.stop(o.end + 0.05)
  }

  /** Одна из посчитанных капель, со скоростью `rate` (выше - мельче). */
  function drop(out: AudioNode, t: number, gain: number, rate = 1, kind: 'drops' | 'bucket' = 'drops'): void {
    const set = bank.audio(ctx, kind)
    if (!set) return
    const s = ctx.createBufferSource()
    s.buffer = set[Math.floor(Math.random() * set.length)]
    s.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = gain
    s.connect(g).connect(out)
    s.start(t)
  }

  // --- Шаги --------------------------------------------------------------------

  /**
   * Нога вдавливается, а не бьёт: удар нарастает 18-26 мс, и громче всего в
   * шаге не он, а чавк, который приходит следом.
   */
  function mud(out: AudioNode, t: number, running: boolean): void {
    const dur = running ? rand(0.08, 0.1) : rand(0.1, 0.15)
    burst(out, t, { type: 'lowpass', freq: rand(300, 600), q: 0.7, attack: rand(0.018, 0.026), peak: NORM.mud * 0.7, end: t + dur })
    const at = t + rand(0.015, 0.035)
    const sq = running ? rand(0.06, 0.08) : rand(0.08, 0.12)
    burst(out, at, { type: 'bandpass', freq: 200, to: 800, q: 3.5, attack: 0.012, peak: NORM.mud * 2, end: at + sq })
  }

  function concrete(out: AudioNode, t: number): void {
    const end = t + rand(0.04, 0.08)
    burst(out, t, { type: 'bandpass', freq: rand(1800, 2600), q: 0.6, attack: 0.001, peak: NORM.concrete, end })
    tone(out, t, { freq: rand(2350, 2650), attack: 0.001, peak: NORM.concrete * 0.08, end: t + 0.07 })
    burst(out, t, { type: 'lowpass', freq: 260, q: 0.7, attack: 0.002, peak: NORM.concrete * 0.6, end: t + 0.04 })
  }

  /** Шаг по маршу: один из посчитанных, пик у каждого - единица. */
  function steel(out: AudioNode, t: number, running: boolean): void {
    const set = bank.audio(ctx, 'steel')
    if (!set) {
      concrete(out, t)
      return
    }
    const s = ctx.createBufferSource()
    s.buffer = set[Math.floor(Math.random() * set.length)]
    const [lo, hi] = running ? STEEL.run : STEEL.walk
    s.playbackRate.value = rand(lo, hi)
    s.connect(out)
    s.start(t)
  }

  /**
   * «Чвак» мокрой подошвы: полоса скользит 300-1200 Гц, в конце подошва
   * отлипает. Пик чвака тише щелчка бетона, но в своей полосе он главный:
   * щелчок сам богат серединой, и чвак слабее этого тонет в нём.
   */
  function squelch(out: AudioNode, t: number, k: number): void {
    const len = rand(0.04, 0.07)
    burst(out, t + 0.004, { type: 'bandpass', freq: 300, to: 1200, q: 3, attack: 0.004, peak: NORM.concrete * 0.7 * k, end: t + 0.004 + len })
    const off = t + 0.004 + len * 0.8
    burst(out, off, { type: 'bandpass', freq: rand(2200, 3000), q: 2, attack: 0.0005, peak: NORM.concrete * 0.12 * k, end: off + 0.012 })
  }

  function splash(out: AudioNode, t: number, gain = 1): void {
    const k = NORM.splash * gain
    burst(out, t, { type: 'bandpass', freq: rand(2500, 6000), q: 0.8, attack: 0.0005, peak: k, end: t + rand(0.005, 0.01) })
    const drops = 3 + Math.floor(Math.random() * 6)
    for (let i = 0; i < drops; i++) drop(out, t + rand(0, 0.04), k * rand(0.1, 0.3), rand(1.1, 2.2))
    tone(out, t, { freq: rand(80, 150), to: 60, attack: 0.002, peak: k * 0.3, end: t + 0.08 })
    burst(out, t + 0.002, { type: 'highpass', freq: 4000, q: 0.7, attack: 0.002, peak: k * 0.7, end: t + rand(0.06, 0.12) })
  }

  /**
   * Шаг. Своими ногами игрок стоит под ухом, поэтому шаг звучит в середине и
   * на полном уровне; чужой шаг на расстоянии - тише и в стороне.
   */
  function step(surface: Surface, x: number, z: number, running: boolean): void {
    const t = ctx.currentTime + 0.005
    const ear = earOf()
    const p = { x, y: ear.y - 1.5, z }
    const heavy = running ? db(2.5) : 1
    const s = spot(p, db(LEVEL.step) * heavy * rand(0.85, 1.05), 1.8, SEND.near)
    const wet = soles.step(surface)
    if (surface === 'mud') mud(s.input, t, running)
    else if (surface === 'steel') steel(s.input, t, running)
    else concrete(s.input, t)
    if (surface === 'water') splash(s.input, t + 0.004, running ? 1.2 : 1)
    if (wet > 0) squelch(s.input, t, wet)
  }

  /** Recorded footfall: the same synthesis as a live step, heard from a fixed microphone. */
  function tapeStep(surface: Surface, x: number, z: number, running: boolean, micX: number, micZ: number): void {
    const t = ctx.currentTime + 0.005
    const d = Math.hypot(x - micX, z - micZ)
    const g = ctx.createGain()
    g.gain.value = db(LEVEL.step) * Math.min(1, 2 / Math.max(2, d))
    const cut = ctx.createBiquadFilter()
    cut.type = 'lowpass'
    cut.frequency.value = 8000 - 6500 * Math.min(1, d / 25)
    g.connect(cut).connect((mix as Bus & { phones?: AudioNode }).phones ?? mix.sfx)
    if (surface === 'mud') mud(g, t, running)
    else if (surface === 'steel') steel(g, t, running)
    else concrete(g, t)
    if (surface === 'water') splash(g, t + 0.004, running ? 1.2 : 1)
  }

  // --- Гром ----------------------------------------------------------------------

  /** Раскат: горбы громкости, срез ползёт вниз. */
  function roll(out: AudioNode, t0: number, dur: number, peak: number, from: number): void {
    const src = noise('brown', t0, dur)
    if (!src) return
    const lp = filter('lowpass', from, 0.6)
    lp.frequency.setValueAtTime(from, t0)
    lp.frequency.exponentialRampToValueAtTime(60, t0 + dur)
    const hp = filter('highpass', 25, 0.7)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t0)
    let t = t0 + rand(0.25, 0.7)
    g.gain.linearRampToValueAtTime(peak, t)
    const humps = 2 + Math.floor(Math.random() * 3)
    const slot = (t0 + dur - t) / (humps + 1)
    let a = peak
    for (let k = 0; k < humps; k++) {
      t += slot * rand(0.35, 0.5)
      g.gain.linearRampToValueAtTime(a * rand(0.3, 0.55), t)
      a *= rand(0.6, 0.85)
      t += slot * rand(0.45, 0.6)
      g.gain.linearRampToValueAtTime(a, t)
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    src.connect(lp).connect(hp).connect(g).connect(out)
  }

  /** Далёкий раскат с копиями: гром приходит от разных краёв неба не разом. */
  function farRoll(t0: number, peak: number): void {
    const a = Math.random() * Math.PI * 2
    const ear = earOf()
    // Место условное, только ради панорамы: гром звучит одинаково громко везде.
    const p = { x: ear.x + Math.cos(a) * 100, y: ear.y + 50, z: ear.z + Math.sin(a) * 100 }
    const s = spot(p, 1, 1e9, SEND.far, street)
    const dur = rand(3.5, 8)
    roll(s.input, t0, dur, peak, rand(170, 230))
    const copies = 1 + Math.floor(Math.random() * 2)
    for (let i = 0; i < copies; i++) {
      const lag = rand(0.1, 0.6)
      roll(s.input, t0 + lag, dur - lag * rand(0.5, 1), peak * rand(0.45, 0.7), rand(140, 200))
    }
  }

  /**
   * Гром. Зовётся в момент вспышки: далёкий раскат приходит через `delay` с,
   * близкий удар - треск через 0.2-0.5 с и сразу за ним раскат.
   */
  function thunder(delay: number, near: boolean): void {
    const now = ctx.currentTime + 0.01
    if (!near) {
      farRoll(now + Math.max(0, delay), db(LEVEL.thunderFar) * NORM.far)
      return
    }
    const t = now + rand(0.2, 0.5)
    const ear = earOf()
    // Удар сверху и чуть в стороне: под самым небом панорама не бывает крайней.
    const s = spot({ x: ear.x + rand(-25, 25), y: ear.y + 60, z: ear.z + rand(-25, 25) }, 1, 1e9, SEND.near, street)
    // Треск - шум, загнанный в насыщение: разряд плотный, почти без провалов, и
    // потому громче всего, что за ним, не только по пику, но и по среднему.
    // Насыщение же держит пик ровно на уровне из таблицы в громком канале.
    const crack = ctx.createGain()
    // Полдецибела запаса: под треском ещё удар и отражения леса.
    crack.gain.value = db(LEVEL.thunderNear - 0.5) / s.channelMax()
    crack.connect(s.input)
    const src = noise('white', t, 0.16)
    if (!src) return
    const shaper = ctx.createWaveShaper()
    shaper.curve = crackCurve()
    shaper.connect(crack)
    src
      .connect(filter('highpass', rand(1800, 3000), 0.7))
      .connect(envelope(t, 0.0015, 1, t + rand(0.08, 0.15)))
      .connect(shaper)
    // Треск рвётся на несколько слабеющих хлопков - через то же насыщение, так
    // что вместе с ним они выше потолка треска не выходят.
    let at = t
    for (let i = 0; i < 3; i++) {
      at += rand(0.012, 0.03)
      burst(shaper, at, { type: 'highpass', freq: rand(1200, 2500), q: 0.7, attack: 0.001, peak: rand(0.06, 0.11), end: at + rand(0.04, 0.08) })
    }
    // Удар - низкая полоса 80-200 Гц на 0.4-0.8 с под треском.
    burst(s.input, t + 0.002, {
      type: 'bandpass',
      freq: rand(90, 160),
      q: 1.2,
      attack: 0.006,
      peak: db(LEVEL.thunderNear) * NORM.boom,
      end: t + rand(0.4, 0.8),
      source: 'brown',
    })
    farRoll(t + rand(0.05, 0.15), db(LEVEL.thunderFar) * NORM.far)
  }

  // --- Опушка ------------------------------------------------------------------

  function bird(p: Point): void {
    const s = spot(p, db(LEVEL.bird.db), LEVEL.bird.ref, SEND.far, street)
    let t = ctx.currentTime + 0.02
    const calls = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < calls; i++) {
      const dur = rand(0.3, 0.6)
      const src = noise('white', t, dur)
      if (!src) return
      const f = filter('bandpass', 800, rand(8, 14))
      const lift = rand(0.9, 1.15)
      f.frequency.setValueAtTime(800 * lift, t)
      f.frequency.exponentialRampToValueAtTime(1500 * lift, t + dur * rand(0.3, 0.45))
      f.frequency.exponentialRampToValueAtTime(600 * lift, t + dur)
      src.connect(f).connect(envelope(t, 0.03, NORM.bird * rand(0.7, 1), t + dur)).connect(s.input)
      t += dur + rand(0.15, 0.4)
    }
  }

  function creak(p: Point): void {
    const s = spot(p, db(LEVEL.creak.db), LEVEL.creak.ref, undefined, street)
    const t = ctx.currentTime + 0.02
    const dur = rand(0.8, 1.6)
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(rand(14, 20), t)
    osc.frequency.linearRampToValueAtTime(rand(26, 38), t + dur * 0.6)
    osc.frequency.linearRampToValueAtTime(rand(16, 24), t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(NORM.creak, t + dur * 0.3)
    g.gain.linearRampToValueAtTime(NORM.creak * 0.6, t + dur * 0.75)
    g.gain.linearRampToValueAtTime(0, t + dur)
    for (const base of [380, 560, 830]) {
      const f = filter('bandpass', base * rand(0.85, 1.15), rand(10, 14))
      osc.connect(f).connect(g)
    }
    g.connect(s.input)
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  function fruit(p: Point): void {
    const s = spot(p, db(LEVEL.fruit.db), LEVEL.fruit.ref, undefined, street)
    let t = ctx.currentTime + 0.02
    const leaves = 3 + Math.floor(Math.random() * 3)
    for (let i = 0; i < leaves; i++) {
      burst(s.input, t, { type: 'bandpass', freq: rand(1200, 3500), q: 1.5, attack: 0.002, peak: NORM.fruit * 0.12, end: t + rand(0.008, 0.02) })
      t += rand(0.03, 0.07)
    }
    t += rand(0.1, 0.2)
    tone(s.input, t, { freq: rand(120, 160), to: 55, attack: 0.002, peak: NORM.fruit * 0.35, end: t + rand(0.08, 0.11) })
    burst(s.input, t, { type: 'lowpass', freq: 400, q: 0.7, attack: 0.001, peak: NORM.fruit, end: t + 0.03 })
  }

  /** Одна капля в точке: в лужу или в полное ведро. */
  function drip(p: Point, kind: 'water' | 'bucket' = 'water'): void {
    const lv = kind === 'bucket' ? LEVEL.bucket : LEVEL.drip
    const s = spot(p, db(lv.db), lv.ref)
    drop(s.input, ctx.currentTime + 0.005, 1, rand(0.92, 1.08), kind === 'bucket' ? 'bucket' : 'drops')
  }

  return {
    step,
    tapeStep,
    splash: (p: Point, gain = 1) => splash(spot(p, db(LEVEL.step), 1.8).input, ctx.currentTime + 0.005, gain),
    thunder,
    bird,
    creak,
    fruit,
    drip,
    /** Капля в чужой узел (источник со своим затенением): пик у набора - единица. */
    dropInto: (out: AudioNode, gain: number, rate = 1, kind: 'drops' | 'bucket' = 'drops') =>
      drop(out, ctx.currentTime + 0.005, gain, rate, kind),
    /** Намочить подошвы (см. `Soles`). */
    soak: () => soles.soak(),
  }
}
