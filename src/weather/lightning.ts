/**
 * weather/lightning.ts — расписание молний и их огибающая.
 *
 * Чистый модуль: ни three, ни звука. Он отвечает на два вопроса - когда
 * следующая молния и насколько ярко сейчас небо - и поэтому проверяется на
 * Node целиком, включая правило фоточувствительности (look.md): не больше
 * трёх вспышек в секунду и ни одной пары молний ближе трёх секунд.
 *
 * Простая идея. Молния - двойной разряд: короткий лидер, тёмная пауза и
 * обратный удар ярче и длиннее, с хвостом. Между молниями 45-120 секунд по
 * семени. Близкий удар бывает, но не больше двух раз за прохождение: он
 * ярче, и треск у него приходит почти сразу.
 */

/** Интервал между молниями, с. */
export const INTERVAL = { min: 45, max: 120 } as const

/** Длительности частей разряда, с. */
export const STROKE = {
  leader: [0.06, 0.09],
  pause: [0.08, 0.15],
  ret: [0.12, 0.2],
} as const

/** Близких ударов за прохождение - не больше. */
export const NEAR_MAX = 2

/** Доля близких среди прочих, пока лимит не выбран. */
const NEAR_CHANCE = 0.12

/** Дальность грома: 2-9 с задержки звука, то есть 0.7-3 км. */
const THUNDER_DELAY = { min: 2, max: 9 } as const
/** Близкий удар: треск через 0.2-0.5 с. */
const NEAR_DELAY = { min: 0.2, max: 0.5 } as const

export type Strike = {
  /** Момент начала лидера, с от начала мира. */
  at: number
  leader: number
  pause: number
  ret: number
  near: boolean
  /** Через сколько после вспышки приходит звук, с. */
  delay: number
  /** Сила вспышки 0..1: множитель неба и отсвета. */
  power: number
  /** Где на небе вспыхнуло: азимут, рад. */
  azimuth: number
}

/** Детерминированный генератор по семени (тот же, что у сборки мира). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const within = (r: () => number, [a, b]: readonly [number, number]): number => a + r() * (b - a)

/**
 * Расписание молний. Первая - не раньше `INTERVAL.min` от начала: первый
 * кадр после пробуждения обязан быть кадром референса, без вспышки.
 */
export function createSchedule(seed: number) {
  const r = rng(seed)
  let nearLeft = NEAR_MAX
  let t = 0

  function next(): Strike {
    t += within(r, [INTERVAL.min, INTERVAL.max])
    const near = nearLeft > 0 && r() < NEAR_CHANCE
    if (near) nearLeft--
    return {
      at: t,
      leader: within(r, STROKE.leader),
      pause: within(r, STROKE.pause),
      ret: within(r, STROKE.ret),
      near,
      delay: near ? within(r, [NEAR_DELAY.min, NEAR_DELAY.max]) : within(r, [THUNDER_DELAY.min, THUNDER_DELAY.max]),
      power: near ? 1 : 0.45 + r() * 0.35,
      azimuth: r() * Math.PI * 2,
    }
  }

  return { next }
}

/**
 * Яркость разряда в момент `t` от начала лидера, 0..1 (умножается на `power`).
 *
 * Лидер - половина силы, плоский верх; пауза - ноль; обратный удар - полная
 * сила с быстрым спадом по экспоненте. Фронты не мгновенные, а 15-20 мс:
 * мгновенный фронт на экране читается щелчком, а не светом.
 */
export function envelope(s: Strike, t: number): number {
  if (t < 0) return 0
  const edge = 0.018
  if (t < s.leader) return 0.5 * Math.min(1, t / edge) * Math.min(1, (s.leader - t) / edge)
  t -= s.leader
  if (t < s.pause) return 0
  t -= s.pause
  if (t < s.ret) {
    const rise = Math.min(1, t / edge)
    return rise * Math.exp((-2.2 * t) / s.ret)
  }
  // Хвост после обратного удара: небо гаснет, а не выключается.
  t -= s.ret
  return Math.exp(-2.2) * Math.exp(-t / 0.08) * (t < 0.5 ? 1 : 0)
}

/** Полная длительность разряда вместе с хвостом, с. */
export function strokeLength(s: Strike): number {
  return s.leader + s.pause + s.ret + 0.5
}

/**
 * Молнии мира во времени: ведёт расписание и отдаёт текущую вспышку.
 * `onStrike` зовётся в момент начала разряда - по нему заводят гром.
 */
export function createLightning(seed: number, onStrike: (s: Strike) => void = () => {}) {
  const schedule = createSchedule(seed)
  let now = 0
  let current: Strike | null = null
  let upcoming = schedule.next()
  let enabled = true

  return {
    /** Сдвинуть время. Возвращает вспышку 0..1 с учётом силы. */
    update(dt: number): number {
      now += dt
      if (enabled && now >= upcoming.at) {
        current = upcoming
        upcoming = schedule.next()
        onStrike(current)
      }
      if (!current) return 0
      const t = now - current.at
      if (t > strokeLength(current)) {
        current = null
        return 0
      }
      return envelope(current, t) * current.power
    },
    /** Текущий разряд, если он идёт: азимут и близость для неба. */
    get strike(): Strike | null {
      return current
    },
    /** Буря выключена - новых молний нет (этап откровения). */
    setEnabled(v: boolean): void {
      enabled = v
    },
  }
}
