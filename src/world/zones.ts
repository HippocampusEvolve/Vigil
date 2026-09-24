/**
 * world/zones.ts — граф нутра: комнаты, проёмы между ними, светильники и
 * точки, откуда звучит нутро.
 *
 * Свет, звук и видимость решаются по графу зон, а не по расстоянию и не по
 * лучам (look.md, «Свет»; sound.md, «Затенение источников»): в какой комнате
 * стоит игрок, какие проёмы открыты, кто за ними. Граф один на всех - на
 * сборку нутра, менеджер света, звук и проверки, - и копий его нет.
 *
 * Комната - это её воздух: прямоугольник в плане между внутренними гранями
 * стен и перегородок, пол и потолок. Точка в толще стены или в проёме ни одной
 * комнате не принадлежит; `zoneAt` отдаёт её той стороне проёма, к которой
 * она ближе.
 *
 * Числа конструкции - из layout.ts; здесь они только складываются в комнаты.
 */

import {
  BLOCK,
  BLOCK_CEILING,
  BLOCK_WALLS,
  DOOR,
  DOORWAY,
  FLOOR,
  GENERATOR,
  HANGAR,
  HANGAR_WALLS,
  HATCH,
  LOWER,
  COLD_DOOR,
  OPENINGS,
  PARTITION,
  PORTHOLE,
} from './layout'

/** Комнаты нутра по буквам gdd.md, раздел 5; `out` - снаружи. */
export type RoomId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J'
export type ZoneId = RoomId | 'out'

/** Пространство для отклика звука (sound.md, «Пространства»). */
export type Space = 'forest' | 'post' | 'lower'

export type Room = {
  id: RoomId
  /** Воздух комнаты в плане. */
  x0: number
  x1: number
  z0: number
  z1: number
  /** Пол. */
  floor: number
  /** Потолок: число - плоский, `vault` - свод ангара (см. `vaultY`). */
  ceiling: number | 'vault'
  space: Space
}

const half = PARTITION / 2
const W = HANGAR.wallThick

/** Комнаты. Границы - грани стен и перегородок, а не оси. */
export const ROOMS: Record<RoomId, Room> = {
  A: { id: 'A', x0: BLOCK_WALLS.A_west.x1, x1: BLOCK_WALLS.A_east.x0, z0: BLOCK_WALLS.AB.z1, z1: BLOCK.z1 - BLOCK.wall, floor: FLOOR.y, ceiling: BLOCK_CEILING, space: 'post' },
  B: { id: 'B', x0: BLOCK.x0 + BLOCK.wall, x1: BLOCK.x1 - BLOCK.wall, z0: BLOCK_WALLS.B_CD.z1, z1: BLOCK_WALLS.AB.z0, floor: FLOOR.y, ceiling: BLOCK_CEILING, space: 'post' },
  C: { id: 'C', x0: BLOCK_WALLS.CD.x1, x1: BLOCK.x1 - BLOCK.wall, z0: BLOCK.z0 + BLOCK.wall, z1: BLOCK_WALLS.B_CD.z0, floor: FLOOR.y, ceiling: BLOCK_CEILING, space: 'post' },
  D: { id: 'D', x0: BLOCK.x0 + BLOCK.wall, x1: BLOCK_WALLS.CD.x0, z0: BLOCK.z0 + BLOCK.wall, z1: BLOCK_WALLS.B_CD.z0, floor: FLOOR.y, ceiling: BLOCK_CEILING, space: 'post' },
  E: { id: 'E', x0: HANGAR_WALLS.EF + half, x1: HANGAR.x1, z0: HANGAR.z0 + W, z1: HANGAR.z1 - W, floor: FLOOR.y, ceiling: 'vault', space: 'post' },
  F: { id: 'F', x0: HANGAR_WALLS.FG + half, x1: HANGAR_WALLS.EF - half, z0: HANGAR.z0 + W, z1: HANGAR.z1 - W, floor: FLOOR.y, ceiling: 'vault', space: 'post' },
  G: { id: 'G', x0: HANGAR_WALLS.GH + half, x1: HANGAR_WALLS.FG - half, z0: HANGAR.z0 + W, z1: HANGAR.z1 - W, floor: FLOOR.y, ceiling: 'vault', space: 'post' },
  H: { id: 'H', x0: HANGAR.x0 + W, x1: HANGAR_WALLS.GH - half, z0: HANGAR.z0 + W, z1: HANGAR.z1 - W, floor: FLOOR.y, ceiling: 'vault', space: 'post' },
  I: { id: 'I', ...LOWER.I, floor: LOWER.floor, ceiling: LOWER.ceiling, space: 'lower' },
  J: { id: 'J', ...LOWER.J, floor: LOWER.floor, ceiling: LOWER.ceiling, space: 'lower' },
}

export const ROOM_IDS = Object.keys(ROOMS) as RoomId[]

/** Свод ангара изнутри: эллипс от верха стен у граней до гребня. */
const VAULT = {
  z: (HANGAR.z0 + HANGAR.z1) / 2,
  a: (HANGAR.z1 - HANGAR.z0) / 2 - HANGAR.wallThick,
  b: HANGAR.ridge - HANGAR.wall - HANGAR.vaultThick,
}

/** Высота свода изнутри над точкой `z` ангара. */
export function vaultY(z: number): number {
  const u = Math.min(1, Math.abs(z - VAULT.z) / VAULT.a)
  return HANGAR.wall + VAULT.b * Math.sqrt(1 - u * u)
}

/** Потолок комнаты над точкой. */
export function ceilingAt(room: Room, z: number): number {
  return room.ceiling === 'vault' ? vaultY(z) : room.ceiling
}

// --- Проёмы -----------------------------------------------------------------

export type PortalKind = 'door' | 'opening' | 'hatch'

/** Двери, у которых есть створка и состояние «насколько открыта». */
export type DoorId = 'entry' | 'inner' | 'med' | 'gen' | 'hatch' | 'cold'

export type Portal = {
  id: string
  a: ZoneId
  b: ZoneId
  kind: PortalKind
  /** Створка, если она есть: её доля открытия и держит проём. */
  door?: DoorId
  /** Объём проёма сквозь толщу стены. */
  x0: number
  x1: number
  y0: number
  y1: number
  z0: number
  z1: number
}

const opening = (u0: number, u1: number, h = DOORWAY.h, y0 = FLOOR.y) => ({ u0, u1, y0, y1: y0 + h })

/** Проёмы нутра. Проём между a и b; снаружи - `out`. */
export const PORTALS: Portal[] = (() => {
  const out: Portal[] = []
  // Входная дверь: в фасаде блока, порог на высоте отмостки.
  out.push({ id: 'entry', a: 'out', b: 'A', kind: 'door', door: 'entry', x0: DOOR.x0, x1: DOOR.x1, y0: DOOR.y0, y1: DOOR.y1, z0: BLOCK.z1 - BLOCK.wall, z1: BLOCK.z1 })
  const inner = opening(OPENINGS.inner.x0, OPENINGS.inner.x1)
  out.push({ id: 'inner', a: 'A', b: 'B', kind: 'door', door: 'inner', x0: inner.u0, x1: inner.u1, y0: inner.y0, y1: inner.y1, z0: BLOCK_WALLS.AB.z0, z1: BLOCK_WALLS.AB.z1 })
  const med = opening(OPENINGS.med.x0, OPENINGS.med.x1)
  out.push({ id: 'med', a: 'B', b: 'D', kind: 'door', door: 'med', x0: med.u0, x1: med.u1, y0: med.y0, y1: med.y1, z0: BLOCK_WALLS.B_CD.z0, z1: BLOCK_WALLS.B_CD.z1 })
  const gen = opening(OPENINGS.gen.x0, OPENINGS.gen.x1)
  out.push({ id: 'gen', a: 'B', b: 'C', kind: 'door', door: 'gen', x0: gen.u0, x1: gen.u1, y0: gen.y0, y1: gen.y1, z0: BLOCK_WALLS.B_CD.z0, z1: BLOCK_WALLS.B_CD.z1 })
  const be = opening(OPENINGS.BE.z0, OPENINGS.BE.z1)
  out.push({ id: 'BE', a: 'B', b: 'E', kind: 'opening', x0: BLOCK.x0, x1: BLOCK.x0 + BLOCK.wall, y0: be.y0, y1: be.y1, z0: be.u0, z1: be.u1 })
  const ef = opening(OPENINGS.EF.z0, OPENINGS.EF.z1)
  out.push({ id: 'EF', a: 'E', b: 'F', kind: 'opening', x0: HANGAR_WALLS.EF - half, x1: HANGAR_WALLS.EF + half, y0: ef.y0, y1: ef.y1, z0: ef.u0, z1: ef.u1 })
  const fg = opening(OPENINGS.FG.z0, OPENINGS.FG.z1)
  out.push({ id: 'FG', a: 'F', b: 'G', kind: 'opening', x0: HANGAR_WALLS.FG - half, x1: HANGAR_WALLS.FG + half, y0: fg.y0, y1: fg.y1, z0: fg.u0, z1: fg.u1 })
  const gh = opening(OPENINGS.GH.z0, OPENINGS.GH.z1)
  out.push({ id: 'GH', a: 'G', b: 'H', kind: 'opening', x0: HANGAR_WALLS.GH - half, x1: HANGAR_WALLS.GH + half, y0: gh.y0, y1: gh.y1, z0: gh.u0, z1: gh.u1 })
  // Люк: толща плиты пола поста над лестницей.
  out.push({ id: 'hatch', a: 'F', b: 'I', kind: 'hatch', door: 'hatch', x0: HATCH.x0, x1: HATCH.x1, y0: FLOOR.y - FLOOR.slab, y1: FLOOR.y, z0: HATCH.z0, z1: HATCH.z1 })
  // Утеплённая дверь холодной: в неё не заходят, но звук и взгляд её знают.
  const cx = (LOWER.I.x1 + LOWER.J.x0) / 2
  out.push({ id: 'cold', a: 'I', b: 'J', kind: 'door', door: 'cold', x0: cx - LOWER.wall / 2, x1: cx + LOWER.wall / 2, y0: LOWER.floor, y1: LOWER.floor + COLD_DOOR.h, z0: COLD_DOOR.z0, z1: COLD_DOOR.z1 })
  return out
})()

/** Соседи комнаты по проёмам. */
export function neighbors(zone: ZoneId): Array<{ zone: ZoneId; portal: Portal }> {
  const out: Array<{ zone: ZoneId; portal: Portal }> = []
  for (const p of PORTALS) {
    if (p.a === zone) out.push({ zone: p.b, portal: p })
    else if (p.b === zone) out.push({ zone: p.a, portal: p })
  }
  return out
}

/** Середина проёма. */
export function portalCenter(p: Portal): { x: number; y: number; z: number } {
  return { x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2, z: (p.z0 + p.z1) / 2 }
}

// --- Где точка ----------------------------------------------------------------

/** Допуск на грани: точка на самой грани стены ещё в комнате. */
const EDGE = 1e-3

function inRoom(r: Room, x: number, y: number, z: number): boolean {
  if (x < r.x0 - EDGE || x > r.x1 + EDGE || z < r.z0 - EDGE || z > r.z1 + EDGE) return false
  // Ниже пола на ладонь - ещё комната (ступня на пороге); толща плиты - уже нет.
  if (y < r.floor - 0.2) return false
  return y <= ceilingAt(r, z) + EDGE
}

/**
 * В какой зоне точка. Комнаты - по воздуху; толща проёма - той стороне, к
 * которой точка ближе; всё остальное - снаружи. Пол нижнего яруса ниже
 * плиты: выше неё точка ищется в жилых комнатах.
 */
export function zoneAt(x: number, y: number, z: number): ZoneId {
  for (const id of ROOM_IDS) if (inRoom(ROOMS[id], x, y, z)) return id
  for (const p of PORTALS) {
    if (x < p.x0 - EDGE || x > p.x1 + EDGE || z < p.z0 - EDGE || z > p.z1 + EDGE) continue
    if (y < p.y0 - 0.5 || y > p.y1 + 0.5) continue
    // Сторона: по той оси, вдоль которой проём тонкий.
    const dx = p.x1 - p.x0
    const dz = p.z1 - p.z0
    const dy = p.y1 - p.y0
    if (p.kind === 'hatch') return y < (p.y0 + p.y1) / 2 ? p.b : p.a
    const along = dx < dz && dx < dy ? 'x' : 'z'
    const mid = along === 'x' ? (p.x0 + p.x1) / 2 : (p.z0 + p.z1) / 2
    const v = along === 'x' ? x : z
    return v < mid === centerOf(p.a, along) < mid ? p.a : p.b
  }
  return 'out'
}

/** Середина зоны по оси. Снаружи - перед фасадом: все проёмы наружу смотрят на +Z. */
function centerOf(zone: ZoneId, along: 'x' | 'z'): number {
  if (zone === 'out') return along === 'z' ? 10 : 0
  const r = ROOMS[zone]
  return along === 'x' ? (r.x0 + r.x1) / 2 : (r.z0 + r.z1) / 2
}

// --- Светильники --------------------------------------------------------------

/**
 * Поведение трубки (look.md, «Трубки»): ровная - микропровал раз в 5-20 с;
 * умирающая - провалы 50-200 мс раз в 3-12 с; мёртвая не горит. Остальные
 * светильники горят ровно, пока есть ток.
 */
export type Behavior = 'steady' | 'dying' | 'dead'

export type FixtureKind = 'tube' | 'cage' | 'desk' | 'phyto' | 'emergency' | 'cold'

export type FixtureId = 'A' | 'B' | 'C' | 'D' | 'E1' | 'E2' | 'F' | 'G' | 'I1' | 'I2' | 'J'

export type Fixture = {
  id: FixtureId
  room: RoomId
  kind: FixtureKind
  /** Где светится: середина лампы. */
  x: number
  y: number
  z: number
  /** Цвет света, линейный. */
  color: number
  behavior: Behavior
  /** Живой свет: сила и дальность точечного источника. */
  intensity: number
  distance: number
  /** Горит от генератора (гаснет в темноту) или от своей батареи. */
  mains: boolean
}

/** Трубка висит на подвесах: столько под потолком. */
const HANG = 0.08

/** Светильники нутра. Лампа входа - снаружи, её числа в world/index.ts. */
export const FIXTURES: Fixture[] = [
  { id: 'A', room: 'A', kind: 'tube', x: 2.5, y: BLOCK_CEILING - HANG, z: -1.35, color: 0xdfe9e2, behavior: 'dying', intensity: 3.2, distance: 7, mains: true },
  { id: 'B', room: 'B', kind: 'tube', x: 3.0, y: BLOCK_CEILING - HANG, z: -3.175, color: 0xdfe9e2, behavior: 'dying', intensity: 2.6, distance: 7, mains: true },
  { id: 'C', room: 'C', kind: 'cage', x: 4.1, y: BLOCK_CEILING - 0.55, z: -5.0, color: 0xffc07a, behavior: 'steady', intensity: 2.8, distance: 7, mains: true },
  { id: 'D', room: 'D', kind: 'tube', x: 1.6, y: BLOCK_CEILING - HANG, z: -5.8, color: 0xd6e4f2, behavior: 'dying', intensity: 3.0, distance: 7, mains: true },
  { id: 'E1', room: 'E', kind: 'tube', x: -3.5, y: 3.3, z: -2.6, color: 0xdfe9e2, behavior: 'steady', intensity: 4.0, distance: 9, mains: true },
  { id: 'E2', room: 'E', kind: 'tube', x: -3.5, y: 3.3, z: -5.4, color: 0xdfe9e2, behavior: 'dead', intensity: 0, distance: 9, mains: true },
  { id: 'F', room: 'F', kind: 'desk', x: -10.0, y: 1.08, z: -0.62, color: 0xffcd8c, behavior: 'steady', intensity: 1.1, distance: 4, mains: true },
  { id: 'G', room: 'G', kind: 'phyto', x: -15.0, y: 1.2, z: -7.0, color: 0xff4fa8, behavior: 'steady', intensity: 3.4, distance: 8, mains: true },
  { id: 'I1', room: 'I', kind: 'emergency', x: -11.6, y: -1.0, z: -7.55, color: 0xff2410, behavior: 'steady', intensity: 2.4, distance: 8, mains: false },
  { id: 'I2', room: 'I', kind: 'emergency', x: -7.6, y: -0.85, z: -0.45, color: 0xff2410, behavior: 'steady', intensity: 2.4, distance: 8, mains: false },
  { id: 'J', room: 'J', kind: 'cold', x: -3.0, y: -2.2, z: -4.0, color: 0x5a9cff, behavior: 'steady', intensity: 1.6, distance: 6, mains: false },
]

export function fixture(id: FixtureId): Fixture {
  const f = FIXTURES.find((x) => x.id === id)
  if (!f) throw new Error(`нет светильника ${id}`)
  return f
}

// --- Точки звука нутра ----------------------------------------------------------

/**
 * Откуда звучат постоянные источники нутра (sound.md, «Что где звучит»).
 * Предметы в комнатах стоят в этих же точках - сборка нутра берёт их отсюда.
 */
export const SOURCES = {
  generator: { x: GENERATOR.x, y: GENERATOR.y, z: GENERATOR.z, room: 'C' as RoomId },
  /** Часы над проёмом в пост, на стене кают-компании. */
  clock: { x: HANGAR_WALLS.EF + half + 0.03, y: FLOOR.y + DOORWAY.h + 0.32, z: (OPENINGS.EF.z0 + OPENINGS.EF.z1) / 2, room: 'E' as RoomId },
  /** Приёмник на серванте у фасада. */
  receiver: { x: -4.5, y: 1.02, z: -0.55, room: 'E' as RoomId },
  /** Течь со свода в ведро. */
  bucket: { x: -1.8, y: FLOOR.y + 0.3, z: -5.4, room: 'E' as RoomId },
  leak: { x: -1.8, y: vaultY(-5.4), z: -5.4, room: 'E' as RoomId },
  /** Раковина лаборатории: капель. */
  labSink: { x: HANGAR_WALLS.GH + half + 0.3, y: 0.85, z: -5.0, room: 'G' as RoomId },
  /** Насосный агрегат у западной стены низа. */
  pump: { x: -12.3, y: LOWER.floor + 0.4, z: -6.8, room: 'I' as RoomId },
  /** Иллюминатор: скрип корпуса слышен отсюда. */
  porthole: { x: PORTHOLE.x, y: LOWER.floor, z: PORTHOLE.z, room: 'I' as RoomId },
  /** Дверь холодной: за ней гул и иней. */
  coldDoor: { x: (LOWER.I.x1 + LOWER.J.x0) / 2, y: LOWER.floor + 1.2, z: (COLD_DOOR.z0 + COLD_DOOR.z1) / 2, room: 'I' as RoomId },
} as const
