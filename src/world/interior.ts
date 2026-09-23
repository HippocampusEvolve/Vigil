/**
 * world/interior.ts — коробка нутра: полы, перегородки, нижний ярус,
 * лестница, коробки дверей, лотки и трубы.
 *
 * Это геометрия мира, а не предметы (tech.md, «Предметы»): стены, двери,
 * лестница и трубы живут в игре, всё, что стоит в комнатах, - в каталоге ядра
 * (furnish.ts). Числа - из layout.ts и zones.ts.
 *
 * Бетон нутра - тот же материал, что снаружи (concrete.ts): внутренняя грань
 * стены и её наружная - одна деталь, и что на ней, решает шейдер по тому, в
 * чей воздух грань смотрит. Поэтому перегородки и полы сливаются в один меш с
 * фасадом по смыслу, но собираются отдельным: нутро - вторая волна загрузки.
 *
 * Правило стыков то же, что у фасада: куски встречаются гранями в разные
 * стороны. Перегородки ангара идут под свод по тем же точкам, что его
 * внутренняя кромка, полы ложатся между гранями стен, марш упирается в кромку
 * люка, стены низа стоят под плитой, а не в ней.
 */

import * as THREE from 'three'
import { box, merge, paint, pipe, wall, type Hole } from './geom'
import { extrudeXHoles, PAINT, vaultInner, type Part } from './post'
import {
  BLOCK,
  BLOCK_CEILING,
  BLOCK_WALLS,
  COLD_DOOR,
  DOORWAY,
  FLOOR,
  HANGAR,
  HANGAR_WALLS,
  HATCH,
  LOWER,
  OPENINGS,
  PARTITION,
  PORTHOLE,
  STAIRS,
} from './layout'
import { vaultY } from './zones'

export type Interior = {
  /** Бетон нутра (материал - общий с фасадом, его ставит сборка). */
  concrete: THREE.BufferGeometry
  /** Сталь: марш, перила, коробки дверей, лотки, трубы. */
  metal: THREE.BufferGeometry
  parts: Part[]
  bodies: Array<{ name: string; geometry: THREE.BufferGeometry }>
  /** Твёрдое для тела: куски стен вокруг проёмов, марш, перила. */
  colliders: THREE.BufferGeometry
}

/** Выше этой отметки над полом своего яруса деталь телу не достать. */
const REACH = 1.8

/** Радиус проёма иллюминатора в полу низа: обод предмета садится в него. */
export const PORTHOLE_HOLE = PORTHOLE.d / 2 + 0.1

/** Подъём ступени и нижняя проступь марша. */
export const RISE = (FLOOR.y - LOWER.floor) / STAIRS.rises
export const STAIR_FOOT = STAIRS.top - (STAIRS.rises - 1) * STAIRS.tread

type Box6 = [number, number, number, number, number, number]

class Pieces extends Array<THREE.BufferGeometry> {
  names: string[] = []
}

/** Горизонтальная плита с проёмами (прямоугольными и круглыми). */
function slab(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y0: number,
  y1: number,
  rects: Array<{ x0: number; x1: number; z0: number; z1: number }> = [],
  circles: Array<{ x: number; z: number; r: number }> = [],
): THREE.BufferGeometry {
  // Форма в (x, -z), выдавленная по +Z формы: поворот на -π/2 вокруг X
  // переводит выдавливание в +Y, а -z формы - в Z мира.
  const shape = new THREE.Shape()
  shape.moveTo(x0, -z1)
  shape.lineTo(x1, -z1)
  shape.lineTo(x1, -z0)
  shape.lineTo(x0, -z0)
  shape.lineTo(x0, -z1)
  for (const h of rects) {
    const p = new THREE.Path()
    p.moveTo(h.x0, -h.z1)
    p.lineTo(h.x0, -h.z0)
    p.lineTo(h.x1, -h.z0)
    p.lineTo(h.x1, -h.z1)
    p.lineTo(h.x0, -h.z1)
    shape.holes.push(p)
  }
  for (const c of circles) {
    const p = new THREE.Path()
    p.absarc(c.x, -c.z, c.r, 0, Math.PI * 2, true)
    shape.holes.push(p)
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 20 })
  g.rotateX(-Math.PI / 2)
  g.translate(0, y0, 0)
  return paint(g, 0xffffff)
}

/**
 * Куски стены вокруг проёмов - для тела. Стена с проёмом одной рамкой не
 * описывается: рамка заперла бы проём. `u` - вдоль стены, как у `wall`.
 */
function around(
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  holes: Hole[],
  make: (a: number, b: number, c: number, d: number) => Box6,
): Box6[] {
  const out: Box6[] = []
  const hs = [...holes].sort((a, b) => a.u0 - b.u0)
  let u = u0
  for (const h of hs) {
    if (h.u0 > u) out.push(make(u, h.u0, v0, v1))
    // Под проёмом (порог) и над ним (перемычка).
    if (h.v0 > v0) out.push(make(h.u0, h.u1, v0, h.v0))
    if (h.v1 < v1) out.push(make(h.u0, h.u1, h.v1, v1))
    u = h.u1
  }
  if (u < u1) out.push(make(u, u1, v0, v1))
  return out
}

export function buildInterior(): Interior {
  const steps = buildInteriorSteps()
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/** Нутро по шагам: вторая волна загрузки собирается между кадрами. */
export function* buildInteriorSteps(): Generator<void, Interior, void> {
  const parts: Part[] = []
  const concrete = new Pieces()
  const metal = new Pieces()
  const solid: Box6[] = []
  const note = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void => {
    parts.push({ name, x0, x1, y0, y1, z0, z1 })
    for (const list of [concrete, metal]) while (list.names.length < list.length) list.names.push(name)
  }
  /** Твёрдое: рамка, если до неё достаёт тело своего яруса. */
  const hard = (b: Box6, floor: number = FLOOR.y): void => {
    if (b[2] < floor + REACH) solid.push(b)
  }

  const t = HANGAR.wallThick
  const half = PARTITION / 2
  const inZ0 = HANGAR.z0 + t
  const inZ1 = HANGAR.z1 - t

  // --- Полы жилого яруса ----------------------------------------------------------
  // Ангар: от торца до западной стены блока, с проёмом люка. Блок: под его
  // западной стеной тоже - иначе в проёме из коридора пол кончался бы щелью.
  const fy0 = FLOOR.y - FLOOR.slab
  concrete.push(slab(HANGAR.x0 + t, HANGAR.x1, inZ0, inZ1, fy0, FLOOR.y, [HATCH]))
  note('пол ангара', HANGAR.x0 + t, HANGAR.x1, fy0, FLOOR.y, inZ0, inZ1)
  // Для тела пол - настил: четыре плиты вокруг люка, иначе рамка закрыла бы проём.
  hard([HANGAR.x0 + t, HATCH.x0, fy0, FLOOR.y, inZ0, inZ1])
  hard([HATCH.x1, HANGAR.x1, fy0, FLOOR.y, inZ0, inZ1])
  hard([HATCH.x0, HATCH.x1, fy0, FLOOR.y, inZ0, HATCH.z0])
  hard([HATCH.x0, HATCH.x1, fy0, FLOOR.y, HATCH.z1, inZ1])
  const blockFloor: Box6 = [BLOCK.x0, BLOCK.x1 - BLOCK.wall, fy0, FLOOR.y, BLOCK.z0 + BLOCK.wall, BLOCK.z1 - BLOCK.wall]
  concrete.push(paint(box(...blockFloor), 0xffffff))
  note('пол блока', ...blockFloor)
  hard(blockFloor)

  // --- Перегородки ангара: от пола под свод --------------------------------------
  // Проём от пола - вырез в контуре снизу, а не дыра (см. `wall` в geom.ts).
  const profileWith = (d: { z0: number; z1: number }): Array<[number, number]> => [
    [inZ1, FLOOR.y],
    ...vaultInner(),
    [inZ0, FLOOR.y],
    [d.z0, FLOOR.y],
    [d.z0, FLOOR.y + DOORWAY.h],
    [d.z1, FLOOR.y + DOORWAY.h],
    [d.z1, FLOOR.y],
  ]
  const doorways: Record<keyof typeof HANGAR_WALLS, { z0: number; z1: number }> = {
    EF: OPENINGS.EF,
    FG: OPENINGS.FG,
    GH: OPENINGS.GH,
  }
  for (const key of Object.keys(HANGAR_WALLS) as Array<keyof typeof HANGAR_WALLS>) {
    const x = HANGAR_WALLS[key]
    const d = doorways[key]
    concrete.push(extrudeXHoles(profileWith(d), [], x - half, x + half))
    note(`перегородка ${key}`, x - half, x + half, FLOOR.y, HANGAR.ridge - HANGAR.vaultThick, inZ0, inZ1)
    const holes: Hole[] = [{ u0: d.z0, u1: d.z1, v0: FLOOR.y, v1: FLOOR.y + DOORWAY.h }]
    for (const b of around(inZ0, inZ1, FLOOR.y, vaultY(-4), holes, (a, b2, c, e) => [x - half, x + half, c, e, a, b2])) hard(b)
  }

  yield

  // --- Перегородки блока ------------------------------------------------------------
  const bx0 = BLOCK.x0 + BLOCK.wall
  const bx1 = BLOCK.x1 - BLOCK.wall
  const top = BLOCK_CEILING
  {
    const w = BLOCK_WALLS.AB
    const holes: Hole[] = [{ u0: OPENINGS.inner.x0, u1: OPENINGS.inner.x1, v0: FLOOR.y, v1: FLOOR.y + DOORWAY.h }]
    concrete.push(paint(wall('z', w.z1, w.z1 - w.z0, bx0, bx1, FLOOR.y, top, holes), 0xffffff))
    note('перегородка тамбура', bx0, bx1, FLOOR.y, top, w.z0, w.z1)
    for (const b of around(bx0, bx1, FLOOR.y, top, holes, (a, b2, c, e) => [a, b2, c, e, w.z0, w.z1])) hard(b)
  }
  {
    const w = BLOCK_WALLS.B_CD
    const holes: Hole[] = [
      { u0: OPENINGS.med.x0, u1: OPENINGS.med.x1, v0: FLOOR.y, v1: FLOOR.y + DOORWAY.h },
      { u0: OPENINGS.gen.x0, u1: OPENINGS.gen.x1, v0: FLOOR.y, v1: FLOOR.y + DOORWAY.h },
    ]
    concrete.push(paint(wall('z', w.z1, w.z1 - w.z0, bx0, bx1, FLOOR.y, top, holes), 0xffffff))
    note('перегородка коридора', bx0, bx1, FLOOR.y, top, w.z0, w.z1)
    for (const b of around(bx0, bx1, FLOOR.y, top, holes, (a, b2, c, e) => [a, b2, c, e, w.z0, w.z1])) hard(b)
  }
  for (const [name, b] of [
    ['перегородка генераторной', [BLOCK_WALLS.CD.x0, BLOCK_WALLS.CD.x1, FLOOR.y, top, BLOCK.z0 + BLOCK.wall, BLOCK_WALLS.B_CD.z0]],
    ['перегородка щитовой', [BLOCK_WALLS.A_east.x0, BLOCK_WALLS.A_east.x1, FLOOR.y, top, BLOCK_WALLS.AB.z1, BLOCK.z1 - BLOCK.wall]],
    ['толща стены тамбура', [BLOCK_WALLS.A_west.x0, BLOCK_WALLS.A_west.x1, FLOOR.y, top, BLOCK_WALLS.AB.z1, BLOCK.z1 - BLOCK.wall]],
  ] as Array<[string, Box6]>) {
    concrete.push(paint(box(...b), 0xffffff))
    note(name, ...b)
    hard(b)
  }

  // Коробки дверей нутра: стальной уголок по трём сторонам проёма, заходит в
  // проём на 5 см - створка упирается в него.
  const frame = (name: string, axis: 'x' | 'z', u0: number, u1: number, v0: number, v1: number, w0: number, w1: number): void => {
    const F = 0.05
    const pieces: Box6[] =
      axis === 'z'
        ? [
            [u0, u0 + F, v0, v1, w0, w1],
            [u1 - F, u1, v0, v1, w0, w1],
            [u0 + F, u1 - F, v1 - F, v1, w0, w1],
          ]
        : [
            [w0, w1, v0, v1, u0, u0 + F],
            [w0, w1, v0, v1, u1 - F, u1],
            [w0, w1, v1 - F, v1, u0 + F, u1 - F],
          ]
    for (const b of pieces) metal.push(paint(box(...b), PAINT.frame))
    const [ax0, ax1, az0, az1] = axis === 'z' ? [u0, u1, w0, w1] : [w0, w1, u0, u1]
    note(name, ax0, ax1, v0, v1, az0, az1)
  }
  frame('коробка внутренней двери', 'z', OPENINGS.inner.x0, OPENINGS.inner.x1, FLOOR.y, FLOOR.y + DOORWAY.h, BLOCK_WALLS.AB.z0, BLOCK_WALLS.AB.z1)
  frame('коробка двери медпункта', 'z', OPENINGS.med.x0, OPENINGS.med.x1, FLOOR.y, FLOOR.y + DOORWAY.h, BLOCK_WALLS.B_CD.z0, BLOCK_WALLS.B_CD.z1)
  frame('коробка двери генераторной', 'z', OPENINGS.gen.x0, OPENINGS.gen.x1, FLOOR.y, FLOOR.y + DOORWAY.h, BLOCK_WALLS.B_CD.z0, BLOCK_WALLS.B_CD.z1)

  yield

  // --- Нижний ярус ------------------------------------------------------------------
  const L = LOWER
  const lw = L.wall
  const lx0 = L.I.x0 - lw
  const lx1 = L.J.x1 + lw
  const lz0 = L.I.z0 - lw
  const lz1 = L.I.z1 + lw
  const lfloor = L.floor
  const lceil = L.ceiling
  // Пол с круглым проёмом иллюминатора: обод предмета садится в проём.
  concrete.push(slab(lx0, lx1, lz0, lz1, lfloor - 0.3, lfloor, [], [{ x: PORTHOLE.x, z: PORTHOLE.z, r: PORTHOLE_HOLE }]))
  note('пол низа', lx0, lx1, lfloor - 0.3, lfloor, lz0, lz1)
  // Настил для тела - целиком: по иллюминатору ходят, его обод вровень с полом.
  hard([lx0, lx1, lfloor - 0.3, lfloor, lz0, lz1], lfloor)
  const lowerWalls: Array<[string, Box6]> = [
    ['низ: задняя стена', [lx0, lx1, lfloor, lceil, lz0, L.I.z0]],
    ['низ: передняя стена', [lx0, lx1, lfloor, lceil, L.I.z1, lz1]],
    ['низ: западная стена', [lx0, L.I.x0, lfloor, lceil, L.I.z0, L.I.z1]],
    ['низ: восточная стена', [L.J.x1, lx1, lfloor, lceil, L.I.z0, L.I.z1]],
  ]
  for (const [name, b] of lowerWalls) {
    concrete.push(paint(box(...b), 0xffffff))
    note(name, ...b)
    hard(b, lfloor)
  }
  // Стена между насосной и холодной - с утеплённой дверью.
  {
    const x1 = L.J.x0
    const x0 = L.I.x1
    const holes: Hole[] = [{ u0: -COLD_DOOR.z1, u1: -COLD_DOOR.z0, v0: lfloor, v1: lfloor + COLD_DOOR.h }]
    concrete.push(paint(wall('x', x1, x1 - x0, -L.I.z1, -L.I.z0, lfloor, lceil, holes), 0xffffff))
    note('низ: стена холодной', x0, x1, lfloor, lceil, L.I.z0, L.I.z1)
    const zh: Hole[] = [{ u0: COLD_DOOR.z0, u1: COLD_DOOR.z1, v0: lfloor, v1: lfloor + COLD_DOOR.h }]
    for (const b of around(L.I.z0, L.I.z1, lfloor, lceil, zh, (a, b2, c, e) => [x0, x1, c, e, a, b2])) hard(b, lfloor)
    frame('коробка двери холодной', 'x', COLD_DOOR.z0, COLD_DOOR.z1, lfloor, lfloor + COLD_DOOR.h, x0 - 0.02, x0 + 0.1)
  }
  // Ниша пульта климата: два пилона из западной стены.
  for (const [z0, z1] of [
    [L.niche.z0 - 0.3, L.niche.z0],
    [L.niche.z1, L.niche.z1 + 0.3],
  ]) {
    const b: Box6 = [L.I.x0, L.niche.x1, lfloor, lceil, z0, z1]
    concrete.push(paint(box(...b), 0xffffff))
    note(`низ: пилон ниши ${z0.toFixed(1)}`, ...b)
    hard(b, lfloor)
  }

  yield

  // --- Лестница ------------------------------------------------------------------------
  // Марш - пила проступей над косым низом, одним телом. Верх марша упирается в
  // кромку проёма люка, низ стоит на полу.
  {
    const pts: Array<[number, number]> = []
    const n = STAIRS.rises - 1
    for (let k = 1; k <= n; k++) {
      const y = FLOOR.y - k * RISE
      const za = STAIRS.top - (k - 1) * STAIRS.tread
      const zb = STAIRS.top - k * STAIRS.tread
      pts.push([za, y], [zb, y])
    }
    const foot = STAIRS.top - n * STAIRS.tread
    pts.push([foot, lfloor])
    // Низ марша: косой, параллельно линии проступей, на 0.22 ниже носиков.
    const slope = RISE / STAIRS.tread
    const under = 0.22
    const zLow = foot + (lfloor - (lfloor - under)) / slope + 0.35
    pts.push([zLow, lfloor])
    pts.push([STAIRS.top, FLOOR.y - RISE - under])
    // Замкнуть по верхнему краю: первая проступь.
    const profile = pts
    const shape = new THREE.Shape()
    profile.forEach(([z, y], i) => (i ? shape.lineTo(-z, y) : shape.moveTo(-z, y)))
    const g = new THREE.ExtrudeGeometry(shape, { depth: STAIRS.x1 - STAIRS.x0, bevelEnabled: false, curveSegments: 1 })
    g.rotateY(Math.PI / 2)
    g.translate(STAIRS.x0, 0, 0)
    metal.push(paint(g, PAINT.steel))
    note('марш', STAIRS.x0, STAIRS.x1, lfloor, FLOOR.y - RISE, foot, STAIRS.top)
    // Тело марша - проступи ступенями: рамка всего марша заперла бы проход под ним.
    for (let k = 1; k <= n; k++) {
      const y = FLOOR.y - k * RISE
      const za = STAIRS.top - (k - 1) * STAIRS.tread
      const zb = STAIRS.top - k * STAIRS.tread
      solid.push([STAIRS.x0, STAIRS.x1, y - under - RISE, y, zb, za])
    }

    // Перила: стойки по обе стороны и поручень вдоль уклона; сверху поручень
    // выходит над полом поста, чтобы за него взяться, спускаясь.
    const RAIL = 0.9
    for (const x of [STAIRS.x0 + 0.03, STAIRS.x1 - 0.03]) {
      const posts: THREE.Vector3[] = []
      for (const k of [1, 4, 7, 10, n]) {
        const y = FLOOR.y - k * RISE
        const z = STAIRS.top - (k - 0.5) * STAIRS.tread
        metal.push(paint(box(x - 0.015, x + 0.015, y, y + RAIL, z - 0.015, z + 0.015), PAINT.steel))
        posts.push(new THREE.Vector3(x, y + RAIL, z))
      }
      const a = posts[0]
      const b = posts[posts.length - 1]
      // Поручень идёт по уклону до кромки люка и дальше над полом поста, к
      // стойке на полу: за него берутся, начиная спуск.
      const dir = new THREE.Vector3().subVectors(a, b).normalize()
      const up = a.clone().addScaledVector(dir, (STAIRS.top - a.z) / dir.z)
      const TOP_POST = STAIRS.top + 0.2
      const tip = new THREE.Vector3(x, FLOOR.y + RAIL, TOP_POST)
      metal.push(paint(pipe(b.clone().addScaledVector(dir, -0.1), up, 0.02, 8), PAINT.steel))
      metal.push(paint(pipe(up, tip, 0.02, 8), PAINT.steel))
      metal.push(paint(box(x - 0.015, x + 0.015, FLOOR.y, FLOOR.y + RAIL - 0.02, TOP_POST - 0.015, TOP_POST + 0.015), PAINT.steel))
      note(`перила ${x.toFixed(2)}`, x - 0.03, x + 0.03, lfloor, FLOOR.y + RAIL, foot, TOP_POST + 0.03)
      solid.push([x - 0.03, x + 0.03, FLOOR.y, FLOOR.y + RAIL, TOP_POST - 0.03, TOP_POST + 0.03])
    }
  }

  yield

  // --- Лотки под сводом и трубы низа -------------------------------------------------
  // Лотки идут по своду вдоль всего ангара, от перегородки до перегородки: в
  // каждой комнате свой кусок, сквозь перегородки не проходят.
  const bays: Array<[number, number]> = [
    [HANGAR.x0 + t, HANGAR_WALLS.GH - half],
    [HANGAR_WALLS.GH + half, HANGAR_WALLS.FG - half],
    [HANGAR_WALLS.FG + half, HANGAR_WALLS.EF - half],
    // Над стенами (выше 2.4) восточная граница кают-компании - фронтон свода.
    [HANGAR_WALLS.EF + half, HANGAR.x1 - t],
  ]
  for (const tz of [-2.1, -5.9]) {
    const yTop = vaultY(tz) - 0.12
    // Дно лотка толще сантиметра: кабель лежит на нём гранью, и нижняя грань
    // кабеля не должна быть ближе сантиметра к нижней грани дна (одна сторона).
    const PLATE = 0.015
    const yFloor = yTop - 0.06 + PLATE
    for (const [x0, x1] of bays) {
      metal.push(paint(box(x0, x1, yTop - 0.06, yFloor, tz - 0.1, tz + 0.1), PAINT.galvanized))
      metal.push(paint(box(x0, x1, yFloor, yTop, tz - 0.1, tz - 0.095), PAINT.galvanized))
      metal.push(paint(box(x0, x1, yFloor, yTop, tz + 0.095, tz + 0.1), PAINT.galvanized))
      for (let c = 0; c < 3; c++) {
        const cz = tz - 0.06 + c * 0.06
        // Восьмигранник гранью вниз: лежит на дне, а не висит над ним.
        const r = 0.018
        const apothem = r * Math.cos(Math.PI / 8)
        const g = pipe(new THREE.Vector3(x0, 0, 0), new THREE.Vector3(x1, 0, 0), r, 8)
        g.rotateX(Math.PI / 8)
        g.translate(0, yFloor + apothem, cz)
        metal.push(paint(g, PAINT.rubber))
      }
      note(`лоток ${tz} ${x0.toFixed(1)}`, x0, x1, yTop - 0.06, yTop, tz - 0.1, tz + 0.1)
    }
  }
  // Трубы низа: вдоль задней и передней стен под потолком и два стояка у
  // насоса. Идут от стены до стены, в марш не заходят.
  const runs: Array<[number, number, number]> = [
    // z, y центра, радиус
    [L.I.z0 + 0.14, lceil - 0.14, 0.09],
    [L.I.z0 + 0.36, lceil - 0.1, 0.05],
    [L.I.z0 + 0.52, lceil - 0.2, 0.035],
    [L.I.z0 + 0.12, lceil - 0.42, 0.06],
    [L.I.z1 - 0.12, lceil - 0.12, 0.07],
    [L.I.z1 - 0.3, lceil - 0.1, 0.04],
    [L.I.z1 - 0.14, lceil - 0.36, 0.05],
  ]
  for (const [z, y, r] of runs) {
    metal.push(paint(pipe(new THREE.Vector3(L.I.x0, y, z), new THREE.Vector3(L.I.x1, y, z), r, 12), r > 0.06 ? PAINT.rust : PAINT.steel))
    note(`труба низа ${z.toFixed(2)} ${y.toFixed(2)}`, L.I.x0, L.I.x1, y - r, y + r, z - r, z + r)
  }
  for (const z of [-7.0, -6.55]) {
    const x = L.I.x0 + 0.12
    metal.push(paint(pipe(new THREE.Vector3(x, lfloor, z), new THREE.Vector3(x, lceil, z), 0.06, 12), PAINT.rust))
    note(`стояк ${z}`, x - 0.06, x + 0.06, lfloor, lceil, z - 0.06, z + 0.06)
    hard([x - 0.06, x + 0.06, lfloor, lceil, z - 0.06, z + 0.06], lfloor)
  }

  yield

  // --- Сборка ---------------------------------------------------------------------------
  const byName = new Map<string, THREE.BufferGeometry[]>()
  for (const list of [concrete, metal]) {
    list.forEach((g, i) => {
      const name = list.names[i] ?? 'без имени'
      byName.set(name, [...(byName.get(name) ?? []), g])
    })
  }
  const bodies = [...byName].map(([name, geos]) => ({ name, geometry: merge(geos) }))
  return {
    concrete: merge(concrete),
    metal: merge(metal),
    parts,
    bodies,
    colliders: merge(solid.map((b) => box(...b))),
  }
}
