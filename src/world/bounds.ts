/**
 * world/bounds.ts — невидимое твёрдое: край поляны и стволы.
 *
 * Край поляны - стена по той же линии, что лес (forest-plan.ts): за ней мира
 * нет, и выход не нужен - единственный путь к свету. Стволы, до которых можно
 * дойти, - столбы по их радиусу. Всё это уходит только в дерево коллизий и
 * в проверку прохода, в кадре его нет.
 */

import * as THREE from 'three'
import { solidTrunks, type ForestPlan } from './forest-plan'

/** Высота стены края: выше макушки и глубже любой ямы поляны. */
const WALL = { bottom: -2, top: 4 } as const

export function buildBounds(plan: ForestPlan): THREE.Mesh[] {
  const hidden = new THREE.MeshBasicMaterial({ visible: false })

  const pos: number[] = []
  const ring = plan.boundary
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i]
    const [bx, bz] = ring[(i + 1) % ring.length]
    pos.push(ax, WALL.bottom, az, bx, WALL.bottom, bz, bx, WALL.top, bz)
    pos.push(ax, WALL.bottom, az, bx, WALL.top, bz, ax, WALL.top, az)
  }
  const edge = new THREE.BufferGeometry()
  edge.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  edge.computeVertexNormals()
  const edgeMesh = new THREE.Mesh(edge, hidden)
  edgeMesh.name = 'edge'
  edgeMesh.visible = false

  const parts: THREE.BufferGeometry[] = []
  for (const t of solidTrunks(plan)) {
    const g = new THREE.CylinderGeometry(t.radius, t.radius * 1.05, 3, 8, 1, false)
    g.translate(t.x, t.y + 1.5, t.z)
    parts.push(g.toNonIndexed())
  }
  const meshes = [edgeMesh]
  if (parts.length) {
    const pos2: number[] = []
    for (const p of parts) pos2.push(...(p.getAttribute('position').array as Float32Array))
    const trunks = new THREE.BufferGeometry()
    trunks.setAttribute('position', new THREE.Float32BufferAttribute(pos2, 3))
    trunks.computeVertexNormals()
    const trunkMesh = new THREE.Mesh(trunks, hidden)
    trunkMesh.name = 'trunk-colliders'
    trunkMesh.visible = false
    meshes.push(trunkMesh)
  }
  return meshes
}
