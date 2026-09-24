/**
 * Свет нутра на Node: бюджет источников по всему маршруту и мигание трубок
 * против правила фоточувствительности. Браузер не нужен - раздача света и
 * расписание мигания считаются числами.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { createLights, flickerSchedule, powerAt, type LightState } from '../src/world/lights'
import { FIXTURES, PORTALS, ROOMS, ROOM_IDS, portalCenter, zoneAt, type RoomId } from '../src/world/zones'
import { FLOOR, LOWER, STAIRS } from '../src/world/layout'

const EYE = 1.62

/** Точки обхода: из середины каждой комнаты через каждый её проём в соседнюю, шагом 0.2 м. */
function walk(): Array<[number, number, number]> {
  const centre = (id: RoomId): [number, number, number] => {
    const r = ROOMS[id]
    return [(r.x0 + r.x1) / 2, r.floor + EYE, (r.z0 + r.z1) / 2]
  }
  const pts: Array<[number, number, number]> = []
  const line = (a: [number, number, number], b: [number, number, number]) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.2))
    for (let i = 0; i <= n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, a[2] + ((b[2] - a[2]) * i) / n])
  }
  for (const p of PORTALS) {
    const c = portalCenter(p)
    const floorY = p.a === 'I' || p.a === 'J' ? LOWER.floor : FLOOR.y
    const mid: [number, number, number] = [c.x, floorY + EYE, c.z]
    const ends = [p.a, p.b].map((z) => (z === 'out' ? ([c.x, FLOOR.y + EYE, c.z + 3] as [number, number, number]) : centre(z as RoomId)))
    line(ends[0], mid)
    line(mid, ends[1])
  }
  // Марш: от верхней проступи до пола низа, глазом над каждой ступенью.
  const x = (STAIRS.x0 + STAIRS.x1) / 2
  const rise = (FLOOR.y - LOWER.floor) / STAIRS.rises
  for (let k = 0; k <= STAIRS.rises; k++) pts.push([x, FLOOR.y - k * rise + EYE, STAIRS.top - k * STAIRS.tread])
  return pts
}

test('обход проходит через каждую комнату', () => {
  const seen = new Set(walk().map(([x, y, z]) => zoneAt(x, y, z)))
  for (const id of ROOM_IDS) assert.ok(seen.has(id), `обход не заходит в ${id}`)
})

test('в любой точке обхода не больше четырёх источников и одна тень', () => {
  const entry = new THREE.SpotLight(0x3aa86a, 145)
  const flash = new THREE.SpotLight(0xffe2c0, 40)
  const camera = new THREE.PerspectiveCamera()
  const lights = createLights({ entry, flash, entryIntensity: 145 })
  const doorsOpen = { entry: 1, inner: 1, med: 1, gen: 1, cold: 1, hatch: 1 }
  const doorsShut = { entry: 0, inner: 0, med: 0, gen: 0, cold: 0, hatch: 1 }
  let worst = 0
  for (const carried of [true, false]) {
    for (const doors of [doorsOpen, doorsShut]) {
      for (const [x, y, z] of walk()) {
        const s: LightState = { x, y, z, carried, doors, mains: true }
        camera.position.set(x, y, z)
        // Несколько кадров в точке: свет перебирается между светильниками не сразу.
        for (let i = 0; i < 4; i++) {
          lights.update(1 / 30, s, camera)
          const c = lights.census()
          worst = Math.max(worst, c.lights)
          assert.ok(c.lights <= 4, `${c.lights} источников в ${c.zone} (${x.toFixed(1)}, ${z.toFixed(1)})`)
          assert.equal(c.shadows, 1, `теней ${c.shadows} в ${c.zone}`)
        }
      }
    }
  }
  assert.ok(worst >= 3, 'обход ни разу не зажёг точечный свет - проверка ничего не проверила')
})

test('трубки мигают не чаще трёх вспышек в секунду', () => {
  // Вспышка - подъём силы больше чем на 10 % (look.md, «Фоточувствительность»);
  // трубка светит всей комнате, то есть больше четверти экрана.
  const HOUR = 3600
  const STEP = 1 / 120
  for (const f of FIXTURES) {
    const dips = flickerSchedule(f.id, HOUR)
    const rises: number[] = []
    let prev = powerAt(dips, 0)
    for (let t = STEP; t < HOUR; t += STEP) {
      const p = powerAt(dips, t)
      if (p - prev > 0.1 * Math.max(prev, 0.05)) rises.push(t)
      prev = p
    }
    let head = 0
    for (let i = 0; i < rises.length; i++) {
      while (rises[i] - rises[head] >= 1) head++
      assert.ok(i - head + 1 <= 3, `${f.id}: ${i - head + 1} вспышек за секунду около ${rises[i].toFixed(2)} с`)
    }
  }
})
