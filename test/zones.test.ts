/**
 * Граф нутра на Node: каждая точка маршрута знает свою комнату, толща проёма
 * отходит той стороне, к которой ближе, проёмы связывают то, что обещают.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { neighbors, PORTALS, ROOMS, ROOM_IDS, zoneAt, vaultY, FIXTURES } from '../src/world/zones'

test('середина каждой комнаты - в своей комнате', () => {
  for (const id of ROOM_IDS) {
    const r = ROOMS[id]
    const x = (r.x0 + r.x1) / 2
    const z = (r.z0 + r.z1) / 2
    assert.equal(zoneAt(x, r.floor + 1, z), id, `комната ${id}`)
    assert.equal(zoneAt(x, r.floor, z), id, `пол комнаты ${id}`)
  }
})

test('снаружи - снаружи', () => {
  assert.equal(zoneAt(-4, 0, 24), 'out')
  assert.equal(zoneAt(2.5, 0.25, 1.5), 'out')
  assert.equal(zoneAt(-12, 5, -4), 'out')
})

test('комнаты не пересекаются', () => {
  for (const a of ROOM_IDS) {
    for (const b of ROOM_IDS) {
      if (a >= b) continue
      const A = ROOMS[a]
      const B = ROOMS[b]
      const plan = A.x0 < B.x1 && B.x0 < A.x1 && A.z0 < B.z1 && B.z0 < A.z1
      const tiers = (A.floor < 0) === (B.floor < 0)
      assert.ok(!(plan && tiers), `${a} и ${b} делят воздух`)
    }
  }
})

test('толща проёма отходит ближней стороне', () => {
  for (const p of PORTALS) {
    const cx = (p.x0 + p.x1) / 2
    const cz = (p.z0 + p.z1) / 2
    const y = p.kind === 'hatch' ? p.y0 : p.y0 + 1
    if (p.kind === 'hatch') {
      assert.equal(zoneAt(cx, p.y1 - 0.01, cz), p.a)
      assert.equal(zoneAt(cx, p.y0 - 0.01, cz), p.b)
      continue
    }
    const thin = p.x1 - p.x0 < p.z1 - p.z0 ? 'x' : 'z'
    const e = 0.01
    const lo = thin === 'x' ? zoneAt(p.x0 + e, y, cz) : zoneAt(cx, y, p.z0 + e)
    const hi = thin === 'x' ? zoneAt(p.x1 - e, y, cz) : zoneAt(cx, y, p.z1 - e)
    assert.notEqual(lo, hi, `проём ${p.id}: обе стороны - ${lo}`)
    assert.deepEqual(new Set([lo, hi]), new Set([p.a, p.b]), `проём ${p.id}`)
  }
})

test('граф связный: из любой комнаты дойти до улицы', () => {
  for (const id of ROOM_IDS) {
    const seen = new Set<string>([id])
    const queue: string[] = [id]
    while (queue.length) {
      const z = queue.shift()!
      for (const n of neighbors(z as never)) if (!seen.has(n.zone)) seen.add(n.zone), queue.push(n.zone)
    }
    assert.ok(seen.has('out'), `${id} отрезана`)
  }
})

test('свод: у стен - верх стены, посередине - гребень изнутри', () => {
  assert.ok(Math.abs(vaultY(-0.3) - 2.4) < 1e-9)
  assert.ok(Math.abs(vaultY(-4) - 3.95) < 1e-9)
})

test('каждый светильник - в своей комнате', () => {
  for (const f of FIXTURES) assert.equal(zoneAt(f.x, f.y, f.z), f.room, `светильник ${f.id}`)
})
