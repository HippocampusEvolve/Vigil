/**
 * sound/hear.ts - как нутро слышно оттуда, где стоит ухо.
 *
 * Затенение считается по графу зон (`world/zones.ts`), а не по лучам: лучи
 * дороги, дрожат на каждом углу и всё равно не знают, что дверь приоткрыта.
 * Граф знает. Звук из другой комнаты приходит двумя дорогами, и слышна
 * громкая:
 *
 *   ЧЕРЕЗ ПРОЁМЫ  по цепочке проёмов от комнаты источника до комнаты уха
 *                 (граф нутра - дерево, цепочка одна). Каждый проём - новый
 *                 источник: до его ближней грани звук доходит по закону
 *                 расстояния от самого источника, дальше расходится от
 *                 дальней грани с опорой 1 м.
 *                 Открытый проём срезает верх на 1 кГц, каждый следующий по
 *                 пути - ещё ниже; закрытая дверь срезает на 300 Гц (входная,
 *                 с окошком, - на 1 кГц) и отнимает свою потерю. Доля
 *                 открытия смешивает два случая: срез и потеря идут между
 *                 ними по логарифму.
 *   СКВОЗЬ СТЕНУ  если комнаты делят стену или перекрытие (или комната
 *                 выходит стеной на улицу), а проёма между ними нет: стена с
 *                 дверью звучит своей дверью. Стена - тоже новый источник: звук
 *                 доходит до её ближней к источнику грани, теряет своё и
 *                 расходится от дальней грани с опорой 1 м. Так генератор за
 *                 стеной звучит своей комнатой, а часы в дальнем углу - почти
 *                 никак.
 *
 * В той же зоне - полная полоса и расстояние до самого источника. Числа
 * затенения - `SHADE` в `levels.ts`.
 *
 * Здесь же решается, в каком пространстве ухо (лес, пост, низ) и как они
 * смешиваются у дверей между пространствами, и когда звучит «вздох» порога.
 *
 * Модуль - чистый счёт, без WebAudio: его прогоняют тесты на Node.
 */

import { BODY } from '../player'
import { BLOCK, FLOOR, HANGAR } from '../world/layout'
import {
  PORTALS,
  ROOMS,
  ROOM_IDS,
  portalCenter,
  vaultY,
  zoneAt,
  type DoorId,
  type Portal,
  type RoomId,
  type Space,
  type ZoneId,
} from '../world/zones'
import { db } from './dsp'
import { SHADE } from './levels'
import { SPACE_TAU } from './mixer'
import { falloff, type Ear, type Point } from './place'

/** Доля открытия каждой двери, 0..1. */
export type Doors = Record<DoorId, number>

/** Двери нутра - те проёмы графа, у которых есть створка. */
export const DOOR_IDS: readonly DoorId[] = PORTALS.flatMap((p) => (p.door ? [p.door] : []))

/** Все двери закрыты: так мир стоит, пока про двери ничего не сказали. */
export function shutDoors(): Doors {
  return Object.fromEntries(DOOR_IDS.map((id) => [id, 0])) as Doors
}

/** Где слушают: ухо, его зона, двери. `changed` - зона сменилась в этом кадре. */
export type Hearing = { ear: Ear; zone: ZoneId; doors: Doors; changed: boolean }

/**
 * Источник: в какой зоне (или зонах - дробь по кровле звучит во всех комнатах
 * под ней) и где. Без точки источник - площадь: во всей своей зоне одинаково.
 */
export type Source = { rooms: readonly ZoneId[]; at?: Point; ref: number }

/**
 * Что слышно: во сколько раз тише, чем на опоре у самого источника, где срез
 * верха (Infinity - полная полоса), откуда звук приходит к уху (сам источник,
 * ближний проём или стена) и откуда он вышел из своей зоны.
 */
export type Heard = { gain: number; cutoff: number; at: Point; from: Point; same: boolean }

// --- Коробки комнат ----------------------------------------------------------------

type Axis = 'x' | 'y' | 'z'
type Box = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }

const lo = (b: Box, a: Axis): number => (a === 'x' ? b.x0 : a === 'y' ? b.y0 : b.z0)
const hi = (b: Box, a: Axis): number => (a === 'x' ? b.x1 : a === 'y' ? b.y1 : b.z1)
const get = (p: Point, a: Axis): number => (a === 'x' ? p.x : a === 'y' ? p.y : p.z)
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Воздух комнаты коробкой; у свода верх - гребень изнутри. */
const BOX = Object.fromEntries(
  ROOM_IDS.map((id) => {
    const r = ROOMS[id]
    const top = r.ceiling === 'vault' ? vaultY((r.z0 + r.z1) / 2) : r.ceiling
    return [id, { x0: r.x0, x1: r.x1, y0: r.floor, y1: top, z0: r.z0, z1: r.z1 }]
  })
) as Record<RoomId, Box>

/** План поста снаружи: за его краем - улица. */
const FOOT = {
  x0: Math.min(HANGAR.x0, BLOCK.x0),
  x1: Math.max(HANGAR.x1, BLOCK.x1),
  z0: Math.min(HANGAR.z0, BLOCK.z0),
  z1: Math.max(HANGAR.z1, BLOCK.z1),
}

/** Толще этого зазор между комнатами - уже не одна стена. */
const WALL = 0.5
/** Меньше этого комнаты перекрываются по стороне - касаются углом, общей стены нет. */
const SIDE = 0.2

type Wall = { axis: Axis; kind: 'wall' | 'slab' }

/** Общая стена (или перекрытие) двух комнат: по какой оси и что это. */
function wallBetween(a: RoomId, b: RoomId): Wall | null {
  const A = BOX[a]
  const B = BOX[b]
  let axis: Axis | null = null
  for (const ax of ['x', 'y', 'z'] as const) {
    const gap = Math.max(lo(A, ax) - hi(B, ax), lo(B, ax) - hi(A, ax))
    if (gap > WALL) return null
    if (gap > -SIDE) {
      if (axis) return null
      axis = ax
    }
  }
  return axis ? { axis, kind: axis === 'y' ? 'slab' : 'wall' } : null
}

const WALLS = new Map<string, Wall | null>()
function wallOf(a: RoomId, b: RoomId): Wall | null {
  const key = `${a}${b}`
  if (!WALLS.has(key)) WALLS.set(key, wallBetween(a, b))
  return WALLS.get(key)!
}

/** Грань комнаты на улицу: ось, где стоит грань, куда наружу и где наружная грань стены. */
type Face = { axis: 'x' | 'z'; at: number; edge: number }

/** Грани комнаты, выходящие на улицу. Нижний ярус под землёй - у него таких нет. */
function exterior(id: RoomId): Face[] {
  const b = BOX[id]
  if (b.y0 < FLOOR.y - FLOOR.slab) return []
  const out: Face[] = []
  if (b.x0 - FOOT.x0 <= WALL) out.push({ axis: 'x', at: b.x0, edge: FOOT.x0 })
  if (FOOT.x1 - b.x1 <= WALL) out.push({ axis: 'x', at: b.x1, edge: FOOT.x1 })
  if (b.z0 - FOOT.z0 <= WALL) out.push({ axis: 'z', at: b.z0, edge: FOOT.z0 })
  if (FOOT.z1 - b.z1 <= WALL) out.push({ axis: 'z', at: b.z1, edge: FOOT.z1 })
  return out
}
const FACES = Object.fromEntries(ROOM_IDS.map((id) => [id, exterior(id)])) as Record<RoomId, Face[]>

/** Ближайшая к точке `p` точка грани комнаты на улицу: изнутри и на наружной грани стены. */
function nearestOutside(id: RoomId, p: Point): { inner: Point; outer: Point } | null {
  const b = BOX[id]
  let best: { inner: Point; outer: Point } | null = null
  let bestD = Infinity
  for (const f of FACES[id]) {
    const inner = {
      x: f.axis === 'x' ? f.at : clamp(p.x, b.x0, b.x1),
      y: clamp(p.y, b.y0, b.y1),
      z: f.axis === 'z' ? f.at : clamp(p.z, b.z0, b.z1),
    }
    const d = dist(inner, p)
    if (d < bestD) {
      bestD = d
      best = { inner, outer: f.axis === 'x' ? { ...inner, x: f.edge } : { ...inner, z: f.edge } }
    }
  }
  return best
}

// --- Проёмы --------------------------------------------------------------------------

const CENTER = new Map<Portal, Point>(PORTALS.map((p) => [p, portalCenter(p)]))

/** Потеря закрытого проёма, дБ: по виду створки. */
function lossOf(p: Portal): number {
  if (p.door === 'cold') return SHADE.loss.cold
  if (p.kind === 'hatch') return SHADE.loss.hatch
  return SHADE.loss.door
}

const ROUTES = new Map<string, Portal[]>()

/** Цепочка проёмов от зоны `a` до зоны `b` (по проёмам - кратчайшая). */
export function route(a: ZoneId, b: ZoneId): Portal[] {
  const key = `${a}>${b}`
  const known = ROUTES.get(key)
  if (known) return known
  const via = new Map<ZoneId, Portal | null>([[a, null]])
  const queue: ZoneId[] = [a]
  while (queue.length && !via.has(b)) {
    const z = queue.shift()!
    for (const p of PORTALS) {
      const next = p.a === z ? p.b : p.b === z ? p.a : null
      if (next && !via.has(next)) {
        via.set(next, p)
        queue.push(next)
      }
    }
  }
  const path: Portal[] = []
  for (let z = b; z !== a; ) {
    const p = via.get(z)
    if (!p) return []
    path.unshift(p)
    z = p.a === z ? p.b : p.a
  }
  ROUTES.set(key, path)
  return path
}

/**
 * Срез одного проёма при доле открытия `o`: между закрытым и открытым по
 * логарифму. У двери со своим срезом (`SHADE.leaky`) закрытое полотно режет
 * выше стены.
 */
export function portalCutoff(o: number, door?: DoorId): number {
  const closed = (door && SHADE.leaky[door]) || SHADE.closed
  const open = Math.max(SHADE.open, closed)
  return closed * Math.pow(open / closed, o)
}

/**
 * Комнаты, между которыми есть проём. Стена с проёмом звучит своим проёмом:
 * полотно и щели пропускают больше бетона вокруг, и звук сквозь такую стену
 * - это звук через её дверь (`SHADE.loss.door`), а не второй путь рядом.
 */
const JOINED = new Set(PORTALS.flatMap((p) => [`${p.a}|${p.b}`, `${p.b}|${p.a}`]))

/** Тонкая ось проёма: вдоль неё проём проходят насквозь. */
function thinAxis(p: Portal): Axis {
  const dx = p.x1 - p.x0
  const dy = p.y1 - p.y0
  const dz = p.z1 - p.z0
  return dy < dx && dy < dz ? 'y' : dx < dz ? 'x' : 'z'
}

const FACE = new Map<string, Point>()

/**
 * Грань проёма со стороны зоны `z`: середина проёма на той его грани, что
 * смотрит в эту зону. Улица - по ту сторону от комнаты.
 */
function faceOf(p: Portal, z: ZoneId): Point {
  const key = `${p.id}>${z}`
  const known = FACE.get(key)
  if (known) return known
  const ax = thinAxis(p)
  const box: Box = { x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1, z0: p.z0, z1: p.z1 }
  const mid = (lo(box, ax) + hi(box, ax)) / 2
  const room = z === 'out' ? (p.a === 'out' ? p.b : p.a) : z
  const r = BOX[room as RoomId]
  const up = (lo(r, ax) + hi(r, ax)) / 2 > mid
  const v = up === (z !== 'out') ? hi(box, ax) : lo(box, ax)
  const c = CENTER.get(p)!
  const face = ax === 'x' ? { ...c, x: v } : ax === 'y' ? { ...c, y: v } : { ...c, z: v }
  FACE.set(key, face)
  return face
}

function viaPortals(src: Source, from: ZoneId, ear: Point, zone: ZoneId, doors: Doors): Heard | null {
  const path = route(from, zone)
  if (!path.length) return null
  const first = faceOf(path[0], from)
  let gain = src.at ? falloff(dist(src.at, first), src.ref) : 1
  let cutoff = Infinity
  let here = from
  let prev = first
  for (const p of path) {
    // Проём - новый источник: входит звук гранью со своей стороны, выходит - с другой.
    gain *= falloff(dist(prev, faceOf(p, here)), 1)
    const o = p.door ? clamp(doors[p.door] ?? 0, 0, 1) : 1
    gain *= Math.pow(db(lossOf(p)), 1 - o)
    cutoff = Math.min(cutoff, portalCutoff(o, p.door))
    here = p.a === here ? p.b : p.a
    prev = faceOf(p, here)
  }
  cutoff = Math.max(SHADE.floor, cutoff * Math.pow(SHADE.hop, path.length - 1))
  gain *= falloff(dist(prev, ear), 1)
  return { gain, cutoff, at: prev, from: first, same: false }
}

function throughWall(src: Source, from: ZoneId, ear: Point, zone: ZoneId): Heard | null {
  const cutoff = SHADE.closed
  if (from !== 'out' && zone !== 'out') {
    const wall = wallOf(from, zone)
    if (!wall) return null
    const E = BOX[zone]
    const S = BOX[from]
    const pick = (a: Axis, box: Box, other: Box): number =>
      a === wall.axis
        ? lo(other, a) >= hi(box, a)
          ? hi(box, a)
          : lo(box, a)
        : clamp(get(ear, a), Math.max(lo(E, a), lo(S, a)), Math.min(hi(E, a), hi(S, a)))
    const near = { x: pick('x', E, S), y: pick('y', E, S), z: pick('z', E, S) }
    const far = { x: pick('x', S, E), y: pick('y', S, E), z: pick('z', S, E) }
    const lit = src.at ? falloff(dist(src.at, far), src.ref) : 1
    return { gain: lit * db(SHADE.loss[wall.kind]) * falloff(dist(near, ear), 1), cutoff, at: near, from: far, same: false }
  }
  if (from === 'out' && zone !== 'out') {
    // Улица за своей стеной: ближняя к уху грань комнаты на улицу.
    const w = nearestOutside(zone, ear)
    if (!w) return null
    return { gain: db(SHADE.loss.wall) * falloff(dist(w.inner, ear), 1), cutoff, at: w.inner, from: w.outer, same: false }
  }
  if (from !== 'out' && zone === 'out') {
    const w = nearestOutside(from, ear)
    if (!w) return null
    const lit = src.at ? falloff(dist(src.at, w.inner), src.ref) : 1
    return { gain: lit * db(SHADE.loss.wall) * falloff(dist(w.outer, ear), 1), cutoff, at: w.outer, from: w.inner, same: false }
  }
  return null
}

/** Две дороги в одну: громкость - громкой, срез - средний по их мощности. */
function merge(a: Heard | null, b: Heard | null): Heard | null {
  if (!a || !b) return a ?? b
  const pa = a.gain * a.gain
  const pb = b.gain * b.gain
  const loud = a.gain >= b.gain ? a : b
  const sum = pa + pb
  const cutoff = sum > 0 ? Math.exp((pa * Math.log(a.cutoff) + pb * Math.log(b.cutoff)) / sum) : loud.cutoff
  return { gain: loud.gain, cutoff, at: loud.at, from: loud.from, same: false }
}

/** Как слышен источник `src` из точки `ear` в зоне `zone` при дверях `doors`. */
export function hear(src: Source, ear: Point, zone: ZoneId, doors: Doors): Heard {
  let best: Heard | null = null
  for (const from of src.rooms) {
    if (from === zone) {
      const at = src.at ?? ear
      return { gain: src.at ? falloff(dist(ear, src.at), src.ref) : 1, cutoff: Infinity, at, from: at, same: true }
    }
    const wall = JOINED.has(`${from}|${zone}`) ? null : throughWall(src, from, ear, zone)
    const h = merge(viaPortals(src, from, ear, zone, doors), wall)
    if (h && (!best || h.gain > best.gain)) best = h
  }
  return best ?? { gain: 0, cutoff: SHADE.floor, at: ear, from: ear, same: false }
}

/**
 * Ухо на улице у точки `p` на краю поста: на `by` метров наружу от ближнего
 * края плана, на высоте глаза стоящего снаружи, взгляд - как у настоящего
 * уха. По нему ставятся слои поляны, пока настоящее ухо внутри: улица
 * звучит так, как её слышно у того проёма или стены, откуда она доходит.
 */
export function outward(p: Point, ear: Ear, by = 0.5): Ear {
  const d = [p.x - FOOT.x0, FOOT.x1 - p.x, p.z - FOOT.z0, FOOT.z1 - p.z]
  const side = d.indexOf(Math.min(...d))
  return {
    x: side === 0 ? FOOT.x0 - by : side === 1 ? FOOT.x1 + by : p.x,
    y: FLOOR.y + BODY.eye,
    z: side === 2 ? FOOT.z0 - by : side === 3 ? FOOT.z1 + by : p.z,
    fx: ear.fx,
    fy: ear.fy,
    fz: ear.fz,
  }
}

// --- Где ухо --------------------------------------------------------------------------

/**
 * Зона уха. Точка в толще стены или перекрытия ничья (`zoneAt` отдаёт её
 * улице); внутри плана поста ухо остаётся там, где было, - иначе камера,
 * прижатая к стене, на кадр выходила бы под дождь.
 */
export function earZone(ear: Point, prev: ZoneId | null): ZoneId {
  const z = zoneAt(ear.x, ear.y, ear.z)
  if (z !== 'out' || prev === null || prev === 'out') return z
  const inPlan = ear.x > FOOT.x0 && ear.x < FOOT.x1 && ear.z > FOOT.z0 && ear.z < FOOT.z1
  return inPlan ? prev : z
}

/** Пространство зоны: снаружи - лес, в жилых комнатах - пост, внизу - низ. */
export function spaceOf(zone: ZoneId): Space {
  return zone === 'out' ? 'forest' : ROOMS[zone].space
}

/**
 * Смесь пространств у открытой двери: сколько чужого пространства слышно из
 * своего. У самого проёма настежь - `share` по амплитуде, к `reach` метрам от
 * него - ноль.
 */
export const BLEND = { share: 0.45, reach: 3 } as const

/**
 * Доли пространств для уха: своё пространство плюс соседнее через открытую
 * дверь между пространствами (входная - лес и пост, люк - пост и низ), по
 * доле открытия и близости к проёму. Отражения разных пространств не
 * совпадают по фазе, поэтому доли сходятся по мощности, а не по сумме.
 */
export function spaceMix(ear: Point, zone: ZoneId, doors: Doors): Record<Space, number> {
  const w: Record<Space, number> = { forest: 0, post: 0, lower: 0 }
  const own = spaceOf(zone)
  for (const p of PORTALS) {
    if (!p.door || (zone !== p.a && zone !== p.b)) continue
    const other = spaceOf(zone === p.a ? p.b : p.a)
    if (other === own) continue
    const near = Math.max(0, 1 - dist(ear, CENTER.get(p)!) / BLEND.reach)
    w[other] = Math.max(w[other], clamp(doors[p.door] ?? 0, 0, 1) * BLEND.share * near)
  }
  let rest = 1
  for (const s of ['forest', 'post', 'lower'] as const) if (s !== own) rest -= w[s] * w[s]
  w[own] = Math.sqrt(Math.max(0, rest))
  return w
}

// --- Порог ----------------------------------------------------------------------------

/** Входная дверь: её порог - событие. */
const ENTRY = PORTALS.find((p) => p.door === 'entry')!

/** Прошло ли ухо порог входной двери (в любую сторону). */
export function crossedEntry(prev: ZoneId, next: ZoneId): boolean {
  return prev !== next && (prev === ENTRY.a || prev === ENTRY.b) && (next === ENTRY.a || next === ENTRY.b)
}

/**
 * «Вздох» давления на пороге: синус 40-60 Гц, 150 мс. Не чаще раза в `gap`
 * секунд - игрок, топчущийся на пороге, не должен пыхтеть.
 */
export const SIGH = { dur: 0.15, lo: 40, hi: 60, gap: 1.5 } as const

/**
 * Когда начать вздох, если порог пройден в `now`: его середина ложится в
 * середину перехода пространств. Переход - `setTargetAtTime` с постоянной
 * `SPACE_TAU`, полпути он проходит за `SPACE_TAU * ln 2`.
 */
export function sighStart(now: number): number {
  return now + SPACE_TAU * Math.LN2 - SIGH.dur / 2
}
