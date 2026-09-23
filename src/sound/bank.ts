/**
 * sound/bank.ts - всё, что звук считает заранее, и порции, которыми он это делает.
 *
 * Постоянные текстуры (дождь, ручей, генератор, завеса капель), шумы для
 * разовых звуков и импульсные отклики пространств - это несколько секунд
 * звука каждая, посчитанные арифметикой. Считать их разом нельзя: это десятки
 * миллисекунд, и кадр, в который они попадут, заметно дёрнется. Поэтому работа
 * режется на порции: `work(бюджет)` считает, пока не выйдет бюджет, и отдаёт
 * управление. Зовётся из кадра, так что к моменту, когда игрок встаёт на ноги,
 * всё уже готово.
 *
 * Аудиоконтекст для этого не нужен: петля - просто массив чисел на заданной
 * частоте дискретизации. Поэтому счёт идёт ещё до жеста игрока, а контекст
 * потом только оборачивает готовое в `AudioBuffer`. Сам массив после этого
 * отпускается - звук живёт в буфере, копия в памяти ни к чему. Буфер к
 * контексту не привязан, и если мёртвый контекст придётся пересоздать, он
 * подойдёт и новому.
 */

import { biquad, filterLoop, polish, rng, SLICE, type Samples } from './dsp'
import { bakeEngine } from './engine'
import { bakeConcrete, bakeLeaves } from './rain'
import { bakeImpulse } from './reverb'
import { bakeCurtain, bakeDrops, bakeStream } from './water'

/** Частота медленного шума: он качает параметры, а не звучит, и густая сетка ему не нужна. */
const WANDER_RATE = 8000

type Baked = Samples | Samples[]

/** Что считать, в каком порядке. Первым - то, что нужно раньше всего. */
const JOBS = [
  { name: 'white', set: false, run: bakeWhite },
  { name: 'brown', set: false, run: bakeBrown },
  { name: 'wander', set: false, run: () => bakeWander() },
  { name: 'irForest', set: false, run: (rate: number) => bakeImpulse('forest', rate) },
  { name: 'leavesL', set: false, run: (rate: number) => bakeLeaves(rate, 0) },
  { name: 'leavesR', set: false, run: (rate: number) => bakeLeaves(rate, 1) },
  { name: 'drops', set: true, run: (rate: number) => bakeDrops(rate) },
  { name: 'engine', set: false, run: (rate: number) => bakeEngine(rate) },
  { name: 'curtain', set: false, run: (rate: number) => bakeCurtain(rate) },
  { name: 'concreteL', set: false, run: (rate: number) => bakeConcrete(rate, 0) },
  { name: 'concreteR', set: false, run: (rate: number) => bakeConcrete(rate, 1) },
  { name: 'stream', set: false, run: (rate: number) => bakeStream(rate) },
  { name: 'irPost', set: false, run: (rate: number) => bakeImpulse('post', rate) },
  { name: 'irLower', set: false, run: (rate: number) => bakeImpulse('lower', rate) },
] as const satisfies ReadonlyArray<{ name: string; set: boolean; run: (rate: number) => Generator<void, Baked> }>

export type BankName = (typeof JOBS)[number]['name']

/**
 * Белый шум, 2 с, от -1 до 1. Основа всех разовых звуков: каждый берёт его со
 * случайного места, поэтому два шага подряд не совпадают.
 */
function* bakeWhite(rate: number): Generator<void, Samples> {
  const r = rng(3)
  const d = new Float32Array(rate * 2)
  for (let i = 0; i < d.length; i++) {
    d[i] = r() * 2 - 1
    if (i % SLICE === SLICE - 1) yield
  }
  return d
}

/**
 * Коричневый шум, 4 с: белый, проинтегрированный с утечкой. Энергия его внизу -
 * основа грома и струи водостока. Приведён к RMS 0.5.
 */
function* bakeBrown(rate: number): Generator<void, Samples> {
  const r = rng(5)
  const d = new Float32Array(rate * 4)
  for (let i = 0; i < d.length; i++) {
    d[i] = r() * 2 - 1
    if (i % SLICE === SLICE - 1) yield
  }
  // Интегратор с утечкой - это срез на ~20 Гц с наклоном 6 дБ на октаву выше.
  yield* filterLoop(d, { b0: 0.0026, b1: 0, b2: 0, a1: -0.9974, a2: 0 }, rate, 1)
  yield* filterLoop(d, biquad('highpass', 20, 0.7, rate), rate)
  yield* polish(d, { rms: 0.5 })
  return d
}

/**
 * Медленный шум, 16 с, от -1 до 1: им гуляют центр струи водостока и ход
 * генератора. Скорость гуляния задаёт скорость проигрывания, а не пересчёт.
 */
function* bakeWander(): Generator<void, Samples> {
  const r = rng(9)
  const d = new Float32Array(WANDER_RATE * 16)
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1
  yield
  yield* filterLoop(d, biquad('lowpass', 1.5, 0.7, WANDER_RATE), WANDER_RATE, 2)
  yield* filterLoop(d, biquad('lowpass', 1.5, 0.7, WANDER_RATE), WANDER_RATE, 2)
  yield* polish(d)
  let peak = 0
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
  for (let i = 0; i < d.length; i++) d[i] /= peak
  return d
}

export type Bank = ReturnType<typeof createBank>

export function createBank(rate: number) {
  const store = new Map<BankName, Samples[]>()
  const buffers = new Map<BankName, AudioBuffer[]>()
  let next = 0
  let gen: Generator<void, Baked> | null = null

  const rateOf = (name: BankName) => (name === 'wander' ? WANDER_RATE : rate)

  /** Досчитать текущую работу на шаг. Возвращает false, когда считать больше нечего. */
  function advance(): boolean {
    if (next >= JOBS.length) return false
    const job = JOBS[next]
    gen ??= job.run(rate)
    const step = gen.next()
    if (step.done) {
      store.set(job.name, Array.isArray(step.value) ? step.value : [step.value])
      gen = null
      next++
    }
    return true
  }

  /**
   * Считать не дольше `budgetMs`. Шаг внутри работы - несколько тысяч
   * отсчётов, так что бюджет перебирается не больше чем на один такой шаг.
   */
  function work(budgetMs: number): void {
    const t0 = performance.now()
    while (advance()) if (performance.now() - t0 >= budgetMs) break
  }

  /** Досчитать всё разом. Для проверок: там кадров нет. */
  function finish(): void {
    while (advance());
  }

  /** Посчитанные массивы, пока они не ушли в буферы. Для проверок на Node. */
  function data(name: BankName): Samples[] | undefined {
    return store.get(name)
  }

  /**
   * Буферы по имени: у петли и отклика - один буфер с каналами, у набора капель -
   * по буферу на каплю. Пусто, если ещё не посчитано.
   */
  function audio(ctx: BaseAudioContext, name: BankName): AudioBuffer[] | null {
    const made = buffers.get(name)
    if (made) return made
    const arrays = store.get(name)
    if (!arrays) return null
    const isSet = JOBS.find((j) => j.name === name)?.set ?? false
    const make = (chans: Samples[]) => {
      const b = ctx.createBuffer(chans.length, chans[0].length, rateOf(name))
      chans.forEach((d, c) => b.copyToChannel(d, c))
      return b
    }
    const list = isSet ? arrays.map((d) => make([d])) : [make(arrays)]
    buffers.set(name, list)
    store.delete(name)
    return list
  }

  return {
    rate,
    work,
    finish,
    data,
    audio,
    /** Один буфер по имени (петля, отклик) или null. */
    buffer(ctx: BaseAudioContext, name: BankName): AudioBuffer | null {
      return audio(ctx, name)?.[0] ?? null
    },
    /** Сколько работ осталось. */
    get pending(): number {
      return JOBS.length - next
    },
  }
}
