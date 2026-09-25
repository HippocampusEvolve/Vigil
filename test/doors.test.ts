import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { buildDoors } from '../src/world/doors'
import { COLD_DOOR, LOWER } from '../src/world/layout'

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
