/**
 * world/doors.ts — створки дверей: входная, внутренняя тамбура, медпункта,
 * генераторной и утеплённая дверь холодной.
 *
 * Коробки дверей - неподвижная геометрия мира (post.ts, interior.ts); здесь
 * только то, что поворачивается на петлях. Створка - меш в группе-петле:
 * группа стоит на оси петли, и открыть дверь - повернуть группу вокруг Y.
 *
 * Твёрдое у створки своё, подвижное: дерево коллизий собрано один раз, а
 * створка ходит. Поэтому тело упирается в створку отрезком в плане
 * (`obstacles`), а не треугольниками дерева.
 *
 * Кто и когда открывает дверь, решает не этот модуль. Здесь - как она
 * открывается: угол, к которому едет створка, скорость, и события для звука
 * (замок, скрип, удар о коробку).
 */

import * as THREE from 'three'
import { box, merge, paint, wall } from './geom'
import { PAINT } from './post'
import { BLOCK, BLOCK_WALLS, COLD_DOOR, DOOR, DOORWAY, FLOOR, LOWER, OPENINGS } from './layout'
import type { DoorId } from './zones'

/** Отрезок створки в плане для тела: от петли до кромки, полутолщина, высоты. */
export type Obstacle = { ax: number; az: number; bx: number; bz: number; half: number; y0: number; y1: number }

export type DoorEvent = 'unlock' | 'open' | 'close' | 'shut'

type Leaf = {
  id: DoorId
  pivot: THREE.Group
  /** Куда открывается: знак угла поворота группы. */
  sign: number
  /** Ширина створки от петли до кромки, м. */
  width: number
  /** Где петля в плане и куда смотрит закрытая створка от петли. */
  hx: number
  hz: number
  dir: THREE.Vector2
  y0: number
  y1: number
  thick: number
  /** Угол сейчас и куда едет, рад; скорость, рад/с. */
  angle: number
  target: number
  speed: number
  /** Полностью открыта, рад. */
  full: number
}

/** Цвет створок: облезлая серо-зелёная входная, внутренние - крашеные. */
const LEAF_PAINT = { entry: PAINT.door, inner: 0x5f7568, med: 0x8a9189, gen: 0x4f5a52, cold: 0x9aa09a } as const

export type Doors = ReturnType<typeof buildDoors>

/**
 * Створки. `metal` и `glass` - материалы поста: те же программы, что у
 * фасада, - створкам не нужно своих.
 */
export function buildDoors(metal: THREE.Material, glass: THREE.Material) {
  const group = new THREE.Group()
  group.name = 'doors'
  const leaves: Leaf[] = []

  /**
   * Створка с петлёй в (hx, hz). Геометрия строится в координатах петли:
   * закрытая створка идёт от петли вдоль `along` (+1 - по +X, -1 - по -X, для
   * двери в стене по Z - вдоль Z) на ширину `width`, толщина уходит в `into`.
   */
  function leaf(o: {
    id: DoorId
    hx: number
    hz: number
    axis: 'x' | 'z'
    along: 1 | -1
    width: number
    y0: number
    y1: number
    thick: number
    /** Толщина уходит от плоскости петли в эту сторону по нормали двери. */
    into: 1 | -1
    sign: 1 | -1
    full: number
    window?: { w: number; y0: number; y1: number }
    color: number
    handleAt?: number
  }): void {
    const pivot = new THREE.Group()
    pivot.name = `door-${o.id}`
    pivot.position.set(o.hx, 0, o.hz)
    // В координатах петли: створка вдоль локальной X (along), толщина по локальной Z.
    const parts: THREE.BufferGeometry[] = []
    const glassParts: THREE.BufferGeometry[] = []
    const u0 = Math.min(0, o.along * o.width)
    const u1 = Math.max(0, o.along * o.width)
    const face = o.into > 0 ? o.thick : 0
    if (o.window) {
      const cx = o.along * o.width / 2
      const hole = { u0: cx - o.window.w / 2, u1: cx + o.window.w / 2, v0: o.window.y0, v1: o.window.y1 }
      parts.push(paint(wall('z', face, o.thick, u0, u1, o.y0, o.y1, [hole]), o.color))
      glassParts.push(paint(box(hole.u0, hole.u1, hole.v0, hole.v1, face - o.thick / 2 - 0.002, face - o.thick / 2 + 0.002), 0xffffff))
    } else {
      parts.push(paint(box(u0, u1, o.y0, o.y1, face - o.thick, face), o.color))
    }
    // Ручка у кромки, с обеих сторон.
    const hu = o.along * (o.width - (o.handleAt ?? 0.1))
    const handleY0 = o.y0 + 0.98
    const handleY1 = o.y0 + 1.1
    for (const s of [1, -1]) {
      const z0 = s > 0 ? face : face - o.thick - 0.05
      parts.push(paint(box(hu - 0.02, hu + 0.02, handleY0, handleY1, z0, z0 + 0.05), PAINT.steel))
    }
    const geo = merge(parts)
    if (o.axis === 'x') {
      // Дверь в стене по X (холодная): створка вдоль Z мира - поворот петли на 90°.
      geo.rotateY(-Math.PI / 2)
      for (const g of glassParts) g.rotateY(-Math.PI / 2)
    }
    const mesh = new THREE.Mesh(geo, metal)
    mesh.name = `door-leaf-${o.id}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    pivot.add(mesh)
    if (glassParts.length) {
      const pane = new THREE.Mesh(merge(glassParts), glass)
      pane.name = `door-glass-${o.id}`
      pivot.add(pane)
    }
    group.add(pivot)
    const dir = o.axis === 'z' ? new THREE.Vector2(o.along, 0) : new THREE.Vector2(0, o.along)
    leaves.push({
      id: o.id,
      pivot,
      sign: o.sign,
      width: o.width,
      hx: o.hx,
      hz: o.hz,
      dir,
      y0: o.y0,
      y1: o.y1,
      thick: o.thick,
      angle: 0,
      target: 0,
      speed: 1.2,
      full: o.full,
    })
  }

  const F = 0.05
  // Входная: петли слева снаружи (у X 2.0), открывается внутрь. Плоскость петли -
  // внутренняя грань створки; толщина уходит наружу, к +Z.
  const entryIn = BLOCK.z1 - DOOR.recess + 0.02
  leaf({
    id: 'entry',
    hx: DOOR.x0 + F,
    hz: entryIn,
    axis: 'z',
    along: 1,
    width: DOOR.x1 - DOOR.x0 - 2 * F,
    y0: DOOR.y0,
    y1: DOOR.y1 - F,
    thick: 0.05,
    into: 1,
    sign: 1,
    full: 1.62,
    window: DOOR.window,
    color: LEAF_PAINT.entry,
    handleAt: 0.14,
  })
  // Внутренняя дверь тамбура: петли у восточного косяка, открывается в тамбур.
  leaf({
    id: 'inner',
    hx: OPENINGS.inner.x1 - F,
    hz: BLOCK_WALLS.AB.z1,
    axis: 'z',
    along: -1,
    width: OPENINGS.inner.x1 - OPENINGS.inner.x0 - 2 * F,
    y0: FLOOR.y + 0.01,
    y1: FLOOR.y + DOORWAY.h - F,
    thick: 0.04,
    into: -1,
    sign: 1,
    full: 1.66,
    color: LEAF_PAINT.inner,
  })
  // Медпункт: петли у западного косяка, в медпункт.
  leaf({
    id: 'med',
    hx: OPENINGS.med.x0 + F,
    hz: BLOCK_WALLS.B_CD.z0,
    axis: 'z',
    along: 1,
    width: OPENINGS.med.x1 - OPENINGS.med.x0 - 2 * F,
    y0: FLOOR.y + 0.01,
    y1: FLOOR.y + DOORWAY.h - F,
    thick: 0.04,
    into: 1,
    sign: 1,
    full: 1.62,
    color: LEAF_PAINT.med,
  })
  // Генераторная: петли у восточного косяка, в генераторную.
  leaf({
    id: 'gen',
    hx: OPENINGS.gen.x1 - F,
    hz: BLOCK_WALLS.B_CD.z0,
    axis: 'z',
    along: -1,
    width: OPENINGS.gen.x1 - OPENINGS.gen.x0 - 2 * F,
    y0: FLOOR.y + 0.01,
    y1: FLOOR.y + DOORWAY.h - F,
    thick: 0.04,
    into: 1,
    sign: -1,
    full: 1.62,
    color: LEAF_PAINT.gen,
  })
  // Холодная: утеплённая, толстая, с окошком; закрыта всегда.
  const coldX = LOWER.I.x1 + 0.02
  leaf({
    id: 'cold',
    hx: coldX,
    hz: COLD_DOOR.z1 - F,
    axis: 'x',
    along: -1,
    width: COLD_DOOR.z1 - COLD_DOOR.z0 - 2 * F,
    y0: LOWER.floor + 0.01,
    y1: LOWER.floor + COLD_DOOR.h - F,
    thick: 0.1,
    into: -1,
    sign: 1,
    full: 0,
    window: { w: COLD_DOOR.window.w, y0: LOWER.floor + COLD_DOOR.window.y0, y1: LOWER.floor + COLD_DOOR.window.y0 + COLD_DOOR.window.h },
    color: LEAF_PAINT.cold,
  })

  const byId = new Map(leaves.map((l) => [l.id, l]))
  const events: Array<{ id: DoorId; kind: DoorEvent; speed: number }> = []

  function place(l: Leaf): void {
    l.pivot.rotation.y = l.sign * l.angle
  }

  /** Двери, которые стоят открытыми с самого начала: к ним никто не прикасается. */
  function prop(id: DoorId, share: number): void {
    const l = byId.get(id)!
    l.angle = l.target = l.full * share
    place(l)
  }

  for (const l of leaves) place(l)

  return {
    group,
    /** Поставить дверь приоткрытой или открытой сразу, без звука. */
    prop,
    /** Велеть створке ехать к доле открытия `share` (0 - закрыта) со скоростью, рад/с. */
    move(id: DoorId, share: number, speed = 1.2): void {
      const l = byId.get(id)!
      const target = l.full * Math.max(0, Math.min(1, share))
      if (Math.abs(target - l.target) < 1e-4) return
      if (target > l.angle + 1e-3) events.push({ id, kind: 'open', speed })
      else if (target < l.angle - 1e-3) events.push({ id, kind: 'close', speed })
      l.target = target
      l.speed = speed
    },
    /** Лязг замка: звук, створка при этом не двигается. */
    unlock(id: DoorId): void {
      events.push({ id, kind: 'unlock', speed: 0 })
    },
    /** Кадр: створки едут к своим углам; пришедшая в ноль бьёт о коробку. */
    update(dt: number): void {
      for (const l of leaves) {
        if (l.angle === l.target) continue
        const step = l.speed * dt
        const was = l.angle
        l.angle = l.angle < l.target ? Math.min(l.target, l.angle + step) : Math.max(l.target, l.angle - step)
        if (was > 0 && l.angle === 0) events.push({ id: l.id, kind: 'shut', speed: l.speed })
        place(l)
      }
    },
    /** События с прошлого вызова: звук их проигрывает. */
    drain(): Array<{ id: DoorId; kind: DoorEvent; speed: number }> {
      return events.splice(0, events.length)
    },
    /** Доля открытия (0..1) каждой двери. */
    open(id: DoorId): number {
      const l = byId.get(id)!
      return l.full > 0 ? l.angle / l.full : 0
    },
    angle(id: DoorId): number {
      return byId.get(id)!.angle
    },
    /** Отрезки створок в плане: то, во что упирается тело. */
    obstacles(): Obstacle[] {
      return leaves.map((l) => {
        const a = l.sign * l.angle
        // Поворот вокруг +Y на угол a: (x, z) -> (x cos a + z sin a, -x sin a + z cos a).
        const dx = l.dir.x * Math.cos(a) + l.dir.y * Math.sin(a)
        const dz = -l.dir.x * Math.sin(a) + l.dir.y * Math.cos(a)
        return { ax: l.hx, az: l.hz, bx: l.hx + dx * l.width, bz: l.hz + dz * l.width, half: l.thick / 2 + 0.02, y0: l.y0, y1: l.y1 }
      })
    },
    /** Тела створок в мировых координатах, в нынешнем положении, - для проверки. */
    bodies(): Array<{ name: string; geometry: THREE.BufferGeometry }> {
      group.updateMatrixWorld(true)
      return leaves.map((l) => {
        const mesh = l.pivot.children[0] as THREE.Mesh
        return { name: `створка ${l.id}`, geometry: mesh.geometry.clone().applyMatrix4(mesh.matrixWorld) }
      })
    },
  }
}
