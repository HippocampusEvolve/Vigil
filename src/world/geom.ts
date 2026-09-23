/**
 * world/geom.ts — кирпичики геометрии мира: коробка, стена с проёмами,
 * труба между двумя точками, слияние в один меш.
 *
 * Статика мира сливается в один меш на материал: сотня коробок фасада - это
 * один вызов отрисовки, а не сотня. Поэтому у всех кусков один набор
 * атрибутов: положение, нормаль и цвет вершины. Цвет - краска конкретной
 * детали (дверь серо-зелёная, бак ржавый), материал у них общий.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Оставить только положение и нормаль, без индекса: так всё сливается. */
function clean(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  return g
}

/** Покрасить кусок: цвет вершины на все вершины. */
export function paint(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = clean(geo)
  const c = new THREE.Color(color)
  const n = g.getAttribute('position').count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return g
}

/** Коробка по границам. */
export function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0)
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  return clean(g)
}

/** Прямоугольный проём в стене: границы в плоскости стены. */
export type Hole = { u0: number; u1: number; v0: number; v1: number }

/**
 * Стена с проёмами одним телом, а не набором коробок вокруг дыр: у набора
 * коробок на лицевой стороне лежат стыки в одной плоскости, и проверка
 * копланарности честно считает их спором.
 *
 * Стена лежит в плоскости `z = face` (лицом на +Z) или `x = face` (лицом на
 * +X) и уходит внутрь на `thick`. `u` - вдоль стены, `v` - высота.
 */
export function wall(
  axis: 'x' | 'z',
  face: number,
  thick: number,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  holes: Hole[] = [],
): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  shape.moveTo(u0, v0)
  shape.lineTo(u1, v0)
  shape.lineTo(u1, v1)
  shape.lineTo(u0, v1)
  shape.lineTo(u0, v0)
  for (const h of holes) {
    const p = new THREE.Path()
    p.moveTo(h.u0, h.v0)
    p.lineTo(h.u0, h.v1)
    p.lineTo(h.u1, h.v1)
    p.lineTo(h.u1, h.v0)
    p.lineTo(h.u0, h.v0)
    shape.holes.push(p)
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, steps: 1, curveSegments: 1 })
  // Выдавлена по +Z от 0 до thick: уводим внутрь, лицом наружу.
  g.translate(0, 0, face - thick)
  if (axis === 'x') {
    // u идёт по -Z, лицо смотрит на +X: поворот на четверть оборота вокруг Y
    // переводит (u, v, w) в (w, v, -u).
    g.translate(0, 0, -face)
    g.rotateY(Math.PI / 2)
    g.translate(face, 0, 0)
  }
  return clean(g)
}

/** Труба-цилиндр между двумя точками. */
export function pipe(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 10): THREE.BufferGeometry {
  const len = a.distanceTo(b)
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false)
  const dir = new THREE.Vector3().subVectors(b, a).normalize()
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  g.applyQuaternion(q)
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return clean(g)
}

/** Слить куски в один меш. Пустой список - пустая геометрия, а не падение. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (!parts.length) return new THREE.BufferGeometry()
  const hasColor = parts.some((p) => p.getAttribute('color'))
  const ready = hasColor ? parts.map((p) => (p.getAttribute('color') ? p : paint(p, 0xffffff))) : parts
  const merged = mergeGeometries(ready, false)
  if (!merged) throw new Error('geom.merge: куски с разными атрибутами')
  merged.computeBoundingSphere()
  merged.computeBoundingBox()
  return merged
}

/** Детерминированный генератор случайных чисел по семени. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
