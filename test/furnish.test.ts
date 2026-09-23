/**
 * Обстановка нутра на Node: вся опись собирается (у каждой роли есть краска),
 * каждый предмет в своей комнате, твёрдое не стоит в проходах, светится только
 * то, что привязано к светильнику, и светильник светит из своей трубки или
 * колбы. Геометрия и наложения - в ките проверки мира (`worlds/vigil.ts`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { furnishMaterials, furnishSteps, GLOW_ROLES, type Furnish, type Item, type Look } from '../src/world/furnish'
import { LAMP_APART, LAMPS, PALETTE, PLACEMENT, ROOM_ITEMS } from '../src/world/placement'
import { ceilingAt, FIXTURES, PORTALS, ROOMS, zoneAt, type RoomId } from '../src/world/zones'

function build(items: Item[] = PLACEMENT): Furnish {
  const m = new THREE.MeshBasicMaterial()
  const steps = furnishSteps({ concrete: m, metal: m, glass: m }, items)
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

// Сборка всей описи - сама по себе проверка: роль без краски, предмет
// снаружи, предмет на несуществующем - ошибка с именем.
const built = build()

const boxOf = (name: string): THREE.Box3 => {
  const b = built.bodies.find((x) => x.name === name)
  assert.ok(b, `нет тела у «${name}»`)
  b.geometry.computeBoundingBox()
  return b.geometry.boundingBox!.clone()
}

test('опись собирается целиком, имена не повторяются', () => {
  assert.equal(built.placed.size, PLACEMENT.length)
  assert.equal(new Set(PLACEMENT.map((i) => i.name)).size, PLACEMENT.length)
  assert.equal(built.bodies.length, PLACEMENT.length)
})

test('роль без краски - ошибка сборки, а не молчаливая подмена', () => {
  const bare: Item = { ...PLACEMENT.find((i) => i.name === 'bench')!, name: 'bench-bare' }
  const m = new THREE.MeshBasicMaterial()
  const steps = furnishSteps({ concrete: m, metal: m, glass: m }, [bare], undefined, { wood: PALETTE.wood })
  assert.throws(() => {
    for (let r = steps.next(); !r.done; r = steps.next());
  }, /нет краски для роли «paint»/)
})

test('каждый предмет - в своей комнате, и весь внутри поста', () => {
  const inset = 0.01
  for (const [room, items] of Object.entries(ROOM_ITEMS) as Array<[RoomId, Item[]]>) {
    for (const item of items) {
      const bb = boxOf(item.name)
      const c = bb.getCenter(new THREE.Vector3())
      assert.equal(zoneAt(c.x, c.y, c.z), room, `«${item.name}» не в комнате ${room}`)
      assert.equal(built.placed.get(item.name)!.room, room)
      bb.expandByScalar(-inset)
      for (const x of [bb.min.x, bb.max.x])
        for (const y of [bb.min.y, bb.max.y])
          for (const z of [bb.min.z, bb.max.z]) assert.notEqual(zoneAt(x, y, z), 'out', `угол «${item.name}» (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) снаружи`)
    }
  }
  // Опись по комнатам и общий список - одно и то же.
  assert.equal(Object.values(ROOM_ITEMS).flat().length, PLACEMENT.length)
})

test('твёрдое не стоит в проходе проёма', () => {
  const REACH = 0.4
  const strips = PORTALS.map((p) => {
    const dx = p.x1 - p.x0
    const dz = p.z1 - p.z0
    const dy = p.y1 - p.y0
    const thin = p.kind === 'hatch' ? 'y' : dx < dz ? 'x' : 'z'
    void dy
    const box = new THREE.Box3(new THREE.Vector3(p.x0, p.y0, p.z0), new THREE.Vector3(p.x1, p.y1, p.z1))
    box.min[thin] -= REACH
    box.max[thin] += REACH
    return { id: p.id, box }
  })
  const solid = PLACEMENT.filter((i) => i.solid)
  assert.ok(solid.length > 20)
  for (const item of solid) {
    const bb = boxOf(item.name)
    for (const s of strips) {
      const hit = bb.min.x < s.box.max.x && bb.max.x > s.box.min.x && bb.min.y < s.box.max.y && bb.max.y > s.box.min.y && bb.min.z < s.box.max.z && bb.max.z > s.box.min.z
      assert.ok(!hit, `«${item.name}» стоит в проходе проёма ${s.id}`)
    }
  }
})

test('светится только то, что привязано к светильнику', () => {
  const ids = new Set(FIXTURES.map((f) => f.id))
  // В палитре светящиеся роли погасшие: горят они только у светильника.
  for (const role of GLOW_ROLES) assert.ok(!('glow' in PALETTE[role]), `роль ${role} в палитре горит сама`)
  const looks: Array<[string, Look]> = []
  for (const item of PLACEMENT) {
    for (const [k, v] of Object.entries(item.looks ?? {})) looks.push([`${item.name}/${k}`, v])
    for (const [k, v] of Object.entries(item.parts ?? {})) looks.push([`${item.name}/${k}`, v])
  }
  let glowing = 0
  for (const [where, look] of looks) {
    if (!('glow' in look)) continue
    glowing++
    assert.ok(look.fixture && ids.has(look.fixture), `${where}: свечение без светильника`)
  }
  assert.ok(glowing >= FIXTURES.length)
  // В собранном: у каждой вершины свечения - номер существующего светильника.
  const glow = furnishMaterials().glow
  let checked = 0
  built.group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || mesh.material !== glow) return
    const surf = mesh.geometry.getAttribute('surf')
    for (let i = 0; i < surf.count; i++) {
      const w = surf.getW(i)
      assert.ok(Number.isInteger(w) && w >= 0 && w < FIXTURES.length, `${mesh.name}: светильник ${w}`)
    }
    checked++
  })
  assert.ok(checked > 0)
})

/** Светящаяся деталь светильника по имени меша каталога. */
const LIGHT_MESH = /tube-fixture-tube|cage-lamp-bulb|desk-lamp-bulb|rack-lamp-tube/

/** Рамки светящихся деталей предмета в мире: он собирается заново там же, где стоит. */
function lightsOf(name: string): THREE.Box3[] {
  const item = PLACEMENT.find((i) => i.name === name)!
  const placed = built.placed.get(name)!
  const blank = new Proxy({} as Record<string, THREE.Material>, { get: () => new THREE.MeshBasicMaterial() })
  const g = item.make(blank).group
  g.position.copy(placed.group.position)
  g.rotation.copy(placed.group.rotation)
  g.updateMatrixWorld(true)
  const out: THREE.Box3[] = []
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && LIGHT_MESH.test(o.name)) out.push(new THREE.Box3().setFromObject(o, true))
  })
  assert.ok(out.length, `у «${name}» нет светящейся детали`)
  return out
}

test('светильник светит из своей трубки или колбы, кроме поимённо разобранных', () => {
  for (const f of FIXTURES) {
    const name = LAMPS[f.id]
    assert.ok(built.placed.has(name), `светильник ${f.id}: нет предмета «${name}»`)
    const p = new THREE.Vector3(f.x, f.y, f.z)
    const inside = lightsOf(name).some((b) => b.expandByScalar(1e-3).containsPoint(p))
    if (LAMP_APART[f.id]) assert.ok(!inside, `светильник ${f.id} в списке расхождений, но светит из своей детали: убрать из списка`)
    else assert.ok(inside, `светильник ${f.id}: точка не в «${name}»`)
  }
})

test('светильники под потолком держатся за потолок', () => {
  for (const name of ['lamp-A', 'lamp-B', 'lamp-C', 'lamp-D', 'lamp-E1', 'lamp-E2', 'lamp-J']) {
    const bb = boxOf(name)
    const room = ROOMS[built.placed.get(name)!.room]
    const c = bb.getCenter(new THREE.Vector3())
    const ceiling = ceilingAt(room, c.z)
    assert.ok(Math.abs(bb.max.y - ceiling) < 1e-3, `«${name}»: верх ${bb.max.y.toFixed(4)}, потолок ${ceiling.toFixed(4)}`)
  }
})

test('погасшая трубка: ожоги на концах её длины', () => {
  const item = PLACEMENT.find((i) => i.name === 'lamp-E2')!
  const look = item.looks!.tube
  assert.ok('kind' in look && look.kind === 'burnt')
  const made = built.placed.get('lamp-E2')!.made as { tubeLength: number }
  assert.ok(Math.abs(made.tubeLength - (look as { span: number }).span) < 1e-6)
})

test('крышка люка: створки на оси Z, левая открывается плюсом, правая минусом', () => {
  // debug.openHatch в main.ts ставит rotation.z = +1.72 левой и -1.72 правой.
  const left = built.moving.get('hatch/leaf-left')
  const right = built.moving.get('hatch/leaf-right')
  assert.ok(left && right)
  assert.equal(left.userData.axis, 'z')
  assert.equal(right.userData.axis, 'z')
  assert.ok(left.userData.range[1] >= 1.72)
  assert.ok(right.userData.range[1] <= -1.72)
  // Крышка стоит без поворота: ось створки - ось Z мира.
  assert.equal(built.placed.get('hatch')!.group.rotation.y, 0)
})

test('подвижные части: группа на своих осях, детали слиты по краскам', () => {
  assert.ok(built.moving.size > 20)
  for (const [key, part] of built.moving) {
    const meshes = part.children.filter((c) => (c as THREE.Mesh).isMesh)
    assert.ok(meshes.length <= 3, `${key}: мешей ${meshes.length}`)
  }
})

test('материалы предметов - одни на всё нутро, сила светильников подключается', () => {
  const a = furnishMaterials()
  const power = { value: FIXTURES.map(() => 0.5) }
  const b = furnishMaterials(power)
  assert.equal(a, b)
  assert.equal(b.glow.uniforms.uPower, power)
  let foreign = 0
  built.group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && mesh.material !== a.opaque && mesh.material !== a.glass && mesh.material !== a.glow) foreign++
  })
  assert.equal(foreign, 0)
})
