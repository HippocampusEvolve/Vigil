/**
 * world/lights.ts — свет нутра: пул живых источников, мигание трубок и
 * раздача света по графу зон.
 *
 * Правило бюджета (look.md, «Свет»; docs/architecture.md, «Рамки»): живых
 * источников не больше четырёх и одна тень. Поэтому источники - постоянный
 * пул: лампа входа, фонарь и два точечных. Прожекторы - источники three,
 * заведённые с первого кадра: от их числа зависит программа каждого
 * материала, и лишний источник на ходу пересобрал бы весь мир посреди кадра.
 * Точечные - свой цикл в шейдере нутра (indoor.ts): уличным программам их код
 * не нужен вовсе.
 * Меняется только, кому они светят: менеджер отдаёт точечные светильникам
 * комнаты игрока и соседней за открытым проёмом, тень - фонарю в руке внутри и
 * лампе входа снаружи. Всем остальным светильникам свет считает формула
 * заполняющего света (indoor.ts), и она уступает живому источнику плавно.
 *
 * Мигание трубок - по закону look.md, «Трубки»: ровная трубка раз в 5-20 с
 * проваливается на 20-40 мс; умирающая - на 50-200 мс раз в 3-12 с и изредка
 * гаснет и перезажигается 2-4 вспышками не чаще одной в 350 мс; мёртвая не
 * горит. Расписание детерминировано по семени - его проверяет тест на правило
 * фоточувствительности, - а сила каждого светильника одна на свет, на его
 * свечение и на звук гула.
 */

import * as THREE from 'three'
import { FIXTURES, fixture, neighbors, portalCenter, zoneAt, type FixtureId, type RoomId, type ZoneId } from './zones'
import { INDOOR, MASK, ROOM_INDEX } from './indoor'
import { LAMP } from './shared'

/** Доли заполняющего света: отражённый есть всегда, прямой - пока нет живого. */
export const FILL = { bounce: 0.28, direct: 0.8 } as const

/** Как быстро живой источник перебирается к другому светильнику, 1/с. */
const HANDOFF = 7
/** Как быстро заполняющий свет уступает живому и возвращается, 1/с. */
const BLEND = 5

// --- Мигание ---------------------------------------------------------------------

/** Генератор случайных чисел по семени: расписание одно и то же каждый раз. */
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

/** Провал силы: с какого момента, сколько длится, до какой силы. */
export type Dip = { at: number; len: number; to: number }

/**
 * Расписание одной трубки на отрезке [0, until): провалы по её поведению.
 * Перезажигание умирающей - это цепочка: погасла, 2-4 вспышки через 350+ мс.
 */
export function flickerSchedule(id: FixtureId, until: number, seed = 3312): Dip[] {
  const f = fixture(id)
  const out: Dip[] = []
  if (f.behavior === 'dead' || f.kind !== 'tube') return out
  const r = rng(seed * 131 + id.charCodeAt(0) * 7 + (id.charCodeAt(1) || 0))
  let t = 1 + r() * 4
  while (t < until) {
    if (f.behavior === 'steady') {
      out.push({ at: t, len: 0.02 + r() * 0.02, to: 0.55 })
      t += 5 + r() * 15
      continue
    }
    // Умирающая: обычно короткий провал, изредка - погасла и перезажглась.
    if (r() < 0.14) {
      const off = 0.5 + r() * 1.0
      out.push({ at: t, len: off, to: 0.0 })
      let k = t + off
      const flashes = 2 + Math.floor(r() * 3)
      for (let i = 0; i < flashes; i++) {
        const on = 0.06 + r() * 0.08
        out.push({ at: k, len: 0.0, to: 1 })
        k += on
        const gap = Math.max(0.35 - on, 0.2) + r() * 0.15
        out.push({ at: k, len: gap, to: 0.0 })
        k += gap
      }
      t = k + 3 + r() * 9
    } else {
      out.push({ at: t, len: 0.05 + r() * 0.15, to: 0.08 + r() * 0.25 })
      t += 3 + r() * 9
    }
  }
  return out.filter((d) => d.len > 0)
}

/** Сила по расписанию в момент `t`: 1 вне провалов. */
export function powerAt(dips: Dip[], t: number): number {
  // Провалов немного и они по порядку: бинарный поиск последнего начавшегося.
  let lo = 0
  let hi = dips.length - 1
  let found = -1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (dips[m].at <= t) {
      found = m
      lo = m + 1
    } else hi = m - 1
  }
  if (found < 0) return 1
  const d = dips[found]
  return t < d.at + d.len ? d.to : 1
}

// --- Пул ------------------------------------------------------------------------

export type Lights = ReturnType<typeof createLights>

/** Где игрок и что у него в руках: всё, от чего зависит раздача света. */
export type LightState = {
  /** Глаз игрока. */
  x: number
  y: number
  z: number
  /** Фонарь в руке. */
  carried: boolean
  /** Доли открытия дверей по id проёма; нет записи - проём без створки. */
  doors: Partial<Record<string, number>>
  /** Ток от генератора: без него гаснут трубки (темнота - этап сценария). */
  mains: boolean
}

type Slot = { fixture: FixtureId | null; fade: number; intensity: number; pos: THREE.Vector3 }

export function createLights(opts: { entry: THREE.SpotLight; flash: THREE.SpotLight; entryIntensity: number }) {
  const { entry, flash } = opts
  const slots: Slot[] = [0, 1].map(() => ({ fixture: null, fade: 0, intensity: 0, pos: new THREE.Vector3() }))

  // Расписания на час вперёд; дальше - по кругу.
  const HOUR = 3600
  const dips = new Map<FixtureId, Dip[]>()
  for (const f of FIXTURES) dips.set(f.id, flickerSchedule(f.id, HOUR))
  /** Сила каждого светильника сейчас: для света, свечения и звука. */
  const power: Record<FixtureId, number> = Object.fromEntries(FIXTURES.map((f) => [f.id, 0])) as Record<FixtureId, number>
  /** Доля живого света у каждого светильника: 0 - считает формула. */
  const live: Record<FixtureId, number> = Object.fromEntries(FIXTURES.map((f) => [f.id, 0])) as Record<FixtureId, number>
  /** Сила свечения для шейдеров: по светильнику, в порядке FIXTURES. */
  const glow = { value: FIXTURES.map(() => 0) }
  let clock = 0
  let zone: ZoneId = 'out'

  /** Кому отдать два точечных: свои светильники комнаты, потом сосед за ближним открытым проёмом. */
  function wanted(s: LightState): FixtureId[] {
    const own = zone === 'out' ? [] : FIXTURES.filter((f) => f.room === zone && f.behavior !== 'dead')
    const out: FixtureId[] = own.map((f) => f.id)
    // Сосед: за ближним открытым проёмом, если там есть живой светильник.
    const around = neighbors(zone)
      .filter((n) => n.zone !== 'out' && (n.portal.door ? (s.doors[n.portal.id] ?? 1) > 0.3 : true))
      .map((n) => {
        const c = portalCenter(n.portal)
        return { zone: n.zone as RoomId, d: Math.hypot(c.x - s.x, c.z - s.z) }
      })
      .sort((a, b) => a.d - b.d)
    for (const n of around) {
      const f = FIXTURES.find((x) => x.room === n.zone && x.behavior !== 'dead')
      if (f && !out.includes(f.id)) out.push(f.id)
    }
    return out.slice(0, slots.length)
  }

  function update(dt: number, s: LightState, camera: THREE.Camera): void {
    clock = (clock + dt) % HOUR
    zone = zoneAt(s.x, s.y, s.z)

    // Сила светильников: ток, поведение, расписание.
    FIXTURES.forEach((f, i) => {
      let p = f.behavior === 'dead' ? 0 : powerAt(dips.get(f.id)!, clock)
      if (f.mains && !s.mains) p = 0
      power[f.id] = p
      glow.value[i] = p
    })

    // Точечные: держатся за своего, пока он нужен; иначе гаснут и переезжают.
    const want = wanted(s)
    const k = 1 - Math.exp(-HANDOFF * dt)
    for (const slot of slots) {
      const keep = slot.fixture && want.includes(slot.fixture)
      if (!keep) {
        slot.fade += (0 - slot.fade) * k
        if (slot.fade < 0.02) {
          slot.fade = 0
          const taken = new Set(slots.map((x) => x.fixture))
          slot.fixture = want.find((id) => !taken.has(id)) ?? null
        }
      } else {
        slot.fade += (1 - slot.fade) * k
      }
    }
    // В шейдер: точка в координатах камеры, свет, дальность, комната.
    camera.updateMatrixWorld()
    slots.forEach((slot, i) => {
      const f = slot.fixture ? fixture(slot.fixture) : null
      slot.intensity = f ? f.intensity * power[f.id] * slot.fade : 0
      if (f) {
        slot.pos.set(f.x, f.y, f.z)
        INDOOR.vgLivePos.value[i].copy(slot.pos).applyMatrix4(camera.matrixWorldInverse)
        INDOOR.vgLiveCol.value[i].setHex(f.color).multiplyScalar(slot.intensity)
        INDOOR.vgLiveRange.value[i] = f.distance
        INDOOR.vgLiveRoom.value[i] = ROOM_INDEX[f.room]
      } else {
        INDOOR.vgLiveCol.value[i].setRGB(0, 0, 0)
        INDOOR.vgLiveRoom.value[i] = -9
      }
    })

    // Заполняющий свет: уступает живому по мере того, как тот разгорается.
    const b = 1 - Math.exp(-BLEND * dt)
    FIXTURES.forEach((f, i) => {
      const slot = slots.find((x) => x.fixture === f.id)
      const target = slot ? slot.fade : 0
      live[f.id] += (target - live[f.id]) * b
      const share = FILL.bounce + FILL.direct * (1 - live[f.id])
      INDOOR.vgFill.value[i].setHex(f.color).multiplyScalar(f.intensity * power[f.id] * share)
    })

    // Тень одна: фонарю в руке, когда игрок внутри; иначе лампе входа. Число
    // прожекторов с тенью не меняется - меняется только, у кого она.
    const inside = zone !== 'out'
    const torchShadow = s.carried && inside
    entry.castShadow = !torchShadow
    flash.castShadow = torchShadow
    // Маски в порядке three: прожектор с тенью первым.
    const entryMask = MASK.outside
    const doorOpen = s.doors.entry ?? 0
    const flashMask = inside ? MASK.all : doorOpen > 0.1 ? MASK.outsideAndA : MASK.outside
    INDOOR.vgSpotMask.value[0] = torchShadow ? flashMask : entryMask
    INDOOR.vgSpotMask.value[1] = torchShadow ? entryMask : flashMask
    INDOOR.vgEntryOpen.value = doorOpen
    INDOOR.vgLampCol.value.copy(LAMP.color.value).multiplyScalar(opts.entryIntensity * LAMP.power.value * 0.75)
  }

  return {
    update,
    /** Сила светильников сейчас: звук гула и свечение трубок идут за ней. */
    power,
    /** Юниформ свечения: сила по светильникам, в порядке FIXTURES. */
    glow,
    /** Сколько живых источников светит сейчас и сколько теней: для проверки бюджета. */
    census(): { lights: number; shadows: number; zone: ZoneId; slots: Array<FixtureId | null> } {
      const on = [entry.intensity, flash.intensity, ...slots.map((s) => s.intensity)].filter((v) => v > 0)
      const shadows = [entry, flash].filter((l) => l.castShadow && l.intensity > 0).length
      return { lights: on.length, shadows, zone, slots: slots.map((s) => s.fixture) }
    },
    get zone(): ZoneId {
      return zone
    },
  }
}
