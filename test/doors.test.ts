import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { buildDoors } from '../src/world/doors'
import { BLOCK_WALLS, COLD_DOOR, LOWER, OPENINGS } from '../src/world/layout'

test('cold-room door handles stay on the lower floor', () => {
  const material = new THREE.MeshBasicMaterial()
  const doors = buildDoors(material, material)
  const leaf = doors.group.getObjectByName('door-leaf-cold') as THREE.Mesh
  assert.ok(leaf)
  leaf.geometry.computeBoundingBox()
  const bounds = leaf.geometry.boundingBox!
  assert.ok(bounds.min.y >= LOWER.floor, `leaf bottom ${bounds.min.y}`)
  assert.ok(bounds.max.y <= LOWER.floor + COLD_DOOR.h, `leaf top ${bounds.max.y}`)
})

test('open vestibule door parks against the partition and clears the entrance', () => {
  const material = new THREE.MeshBasicMaterial()
  const doors = buildDoors(material, material)
  doors.prop('inner', 1)
  const leaf = doors.obstacles()[1]
  assert.ok(leaf.bx > OPENINGS.inner.x1 + 0.7, `leaf tip x ${leaf.bx}`)
  assert.ok(Math.abs(leaf.bz - BLOCK_WALLS.AB.z1) < 0.15, `leaf tip z ${leaf.bz}`)
})
