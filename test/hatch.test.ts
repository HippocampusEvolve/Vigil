/**
 * Крышка люка и перила марша на Node. Закрытая крышка не проходит сквозь сталь
 * нутра; верх перил, который она пересекла бы, - отдельный меш
 * (`Interior.hatchRail`), и main.ts ставит его, только пока люк открыт.
 * Наложения при открытом люке - в ките проверки мира (`worlds/vigil.ts`,
 * створки там открыты).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { buildInterior } from '../src/world/interior'
import { furnishSteps } from '../src/world/furnish'
import { PLACEMENT } from '../src/world/placement'
import { FLOOR, HATCH } from '../src/world/layout'

const interior = buildInterior()

const lid = (() => {
  const m = new THREE.MeshBasicMaterial()
  const steps = furnishSteps({ concrete: m, metal: m, glass: m }, PLACEMENT.filter((i) => i.name === 'hatch'))
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
})()

/** Закрытые створки (лист, рамка, петли) рамками в мировых координатах, на миллиметр внутрь. */
function closedLeaves(): THREE.Box3[] {
  return ['hatch/leaf-left', 'hatch/leaf-right'].map((key) => {
    const leaf = lid.moving.get(key)
    assert.ok(leaf, `нет створки ${key}`)
    assert.equal(leaf.rotation.z, 0, `${key}: створка не закрыта`)
    leaf.updateWorldMatrix(true, true)
    return new THREE.Box3().setFromObject(leaf, true).expandByScalar(-0.001)
  })
}

/** Сколько треугольников геометрии задевают хоть одну рамку. */
function hits(geo: THREE.BufferGeometry, boxes: THREE.Box3[]): number {
  const pos = geo.getAttribute('position')
  const index = geo.index
  const count = index ? index.count : pos.count
  const tri = new THREE.Triangle()
  let n = 0
  for (let i = 0; i < count; i += 3) {
    const at = (k: number) => (index ? index.getX(i + k) : i + k)
    tri.a.fromBufferAttribute(pos, at(0))
    tri.b.fromBufferAttribute(pos, at(1))
    tri.c.fromBufferAttribute(pos, at(2))
    if (boxes.some((b) => b.intersectsTriangle(tri))) n++
  }
  return n
}

test('закрытая крышка люка не проходит сквозь сталь нутра', () => {
  assert.equal(hits(interior.metal, closedLeaves()), 0)
})

test('верх перил - ровно то, на что легла бы закрытая крышка: он и отделён', () => {
  // Без этого отдельный верх не нужен: пусть бы стоял со всей сталью.
  assert.ok(hits(interior.hatchRail, closedLeaves()) > 0)
})

test('стойки верха перил стоят на полу поста за кромкой люка', () => {
  assert.equal(interior.hatchPosts.length, 2)
  for (const p of interior.hatchPosts) {
    assert.equal(p.y0, FLOOR.y)
    assert.ok(p.z - p.half > HATCH.z1, `стойка ${p.x.toFixed(2)} заходит в проём люка`)
    assert.ok(p.x > HATCH.x0 && p.x < HATCH.x1, `стойка ${p.x.toFixed(2)} не у марша`)
  }
})
