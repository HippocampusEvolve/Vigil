/**
 * world/cables.ts — кабели по земле: четыре толстых от входного блока и
 * тонкие от мачт микрофонов к гильзам у стен.
 *
 * Кабель лежит на рельефе: высота каждой точки - `heightAt` плюс радиус.
 * Между корнями он провисает, местами утоплен в грязь - это законно по
 * замыслу и стоит в поимённом списке проверки (tech.md, «Проверки»). У стены
 * кабель поднимается к гильзе.
 *
 * Все кабели - один меш: чёрная мокрая резина, один вызов отрисовки.
 */

import * as THREE from 'three'
import { rng } from './geom'
import { heightAt } from './terrain'
import { BLOCK, CABLE_SLEEVE, GEOPHONE, HANGAR, MASTS, THICK_CABLES } from './layout'

export const THICK_R = 0.04
export const THIN_R = 0.02

/** Шаг выборки вдоль кабеля, м: чаще волн грязи, реже, чем видно глазу. */
const STEP = 0.35

/** Тонкие кабели: от основания мачты или штыря к гильзе у стены (x, y, z). */
function thinRoutes(): Array<{ from: [number, number]; to: [number, number, number]; via?: Array<[number, number]> }> {
  const [m1, m2, m3] = MASTS
  return [
    { from: [m1.x, m1.z], to: [CABLE_SLEEVE.x, CABLE_SLEEVE.y, CABLE_SLEEVE.z - 0.02], via: [[-10.6, -10.5]] },
    { from: [m2.x, m2.z], to: [HANGAR.x0 - 0.02, 0.3, -0.7], via: [[-25.6, 3.6]] },
    { from: [m3.x, m3.z], to: [BLOCK.x1 + 0.02, 0.3, -0.6], via: [[9.5, 12], [7.4, 2.5]] },
    { from: [GEOPHONE.x, GEOPHONE.z], to: [CABLE_SLEEVE.x + 0.12, CABLE_SLEEVE.y - 0.05, CABLE_SLEEVE.z - 0.02] },
  ]
}

/** Точки ломаной в плане, пересобранные с шагом `STEP`. */
function resample(nodes: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 1; i < nodes.length; i++) {
    const [ax, az] = nodes[i - 1]
    const [bx, bz] = nodes[i]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP))
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n])
  }
  out.push([nodes[nodes.length - 1][0], nodes[nodes.length - 1][1]])
  return out
}

/**
 * Высоты вдоль кабеля: на земле, с провисами между «корнями» и участками,
 * утопленными в грязь. Корни - случайные точки, где кабель лёг на бугор.
 */
function profile(pts: Array<[number, number]>, radius: number, seed: number): number[] {
  const r = rng(seed)
  const ys = pts.map(([x, z]) => heightAt(x, z) + radius * 0.9)
  let i = 2 + Math.floor(r() * 6)
  while (i < pts.length - 3) {
    const kind = r()
    const span = 3 + Math.floor(r() * 5)
    if (kind < 0.35) {
      // Лёг на корень: подъём и провис до следующей опоры.
      const lift = 0.05 + r() * 0.1
      for (let k = 0; k <= span && i + k < pts.length - 1; k++) {
        const t = k / span
        ys[i + k] += lift * Math.sin(Math.PI * t) * (1 - 0.6 * Math.sin(Math.PI * t))
      }
    } else if (kind < 0.6) {
      // Утоплен в грязь почти целиком.
      for (let k = 0; k <= span && i + k < pts.length - 1; k++) ys[i + k] -= radius * 1.3 * Math.sin((Math.PI * k) / span)
    }
    i += span + 2 + Math.floor(r() * 6)
  }
  return ys
}

/** Труба вдоль трёхмерной ломаной: кольца в каждой точке. */
function tube(points: THREE.Vector3[], radius: number, radial: number, out: { pos: number[]; nor: number[]; index: number[] }): void {
  const base = out.pos.length / 3
  const tangent = new THREE.Vector3()
  const side = new THREE.Vector3()
  const up = new THREE.Vector3()
  const ref = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)]
    const b = points[Math.min(points.length - 1, i + 1)]
    tangent.subVectors(b, a).normalize()
    side.crossVectors(tangent, Math.abs(tangent.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : ref).normalize()
    up.crossVectors(side, tangent).normalize()
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2
      const nx = side.x * Math.cos(ang) + up.x * Math.sin(ang)
      const ny = side.y * Math.cos(ang) + up.y * Math.sin(ang)
      const nz = side.z * Math.cos(ang) + up.z * Math.sin(ang)
      out.pos.push(points[i].x + nx * radius, points[i].y + ny * radius, points[i].z + nz * radius)
      out.nor.push(nx, ny, nz)
    }
  }
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * (radial + 1) + j
      const b = a + radial + 1
      out.index.push(a, a + 1, b, a + 1, b + 1, b)
    }
  }
}

export function buildCables(): THREE.Mesh {
  const out = { pos: [] as number[], nor: [] as number[], index: [] as number[] }

  THICK_CABLES.forEach((nodes, n) => {
    const pts = resample(nodes)
    const ys = profile(pts, THICK_R, 31 + n)
    const line = pts.map(([x, z], i) => new THREE.Vector3(x, ys[i], z))
    // Из стены кабель выходит на высоте гильзы и опускается на землю.
    const wallEnd = line[0]
    line[0] = new THREE.Vector3(wallEnd.x, 0.16, wallEnd.z)
    line.splice(1, 0, new THREE.Vector3(wallEnd.x, 0.1, wallEnd.z + 0.18))
    tube(line, THICK_R, 7, out)
  })

  thinRoutes().forEach((route, n) => {
    const nodes: Array<[number, number]> = [route.from, ...(route.via ?? []), [route.to[0], route.to[2]]]
    const pts = resample(nodes)
    const ys = profile(pts, THIN_R, 71 + n)
    const line = pts.map(([x, z], i) => new THREE.Vector3(x, ys[i], z))
    // От мачты кабель спускается по трубе, у стены - поднимается к гильзе.
    line.unshift(new THREE.Vector3(route.from[0], heightAt(route.from[0], route.from[1]) + 1.0, route.from[1] + 0.07))
    line[1].z = route.from[1] + 0.07
    line.push(new THREE.Vector3(route.to[0], route.to[1], route.to[2]))
    tube(line, THIN_R, 5, out)
  })

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3))
  g.setIndex(out.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(out.index, 1) : new THREE.Uint16BufferAttribute(out.index, 1))
  g.computeBoundingSphere()
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x151617, roughness: 0.28, metalness: 0 }))
  mesh.name = 'cables'
  mesh.receiveShadow = true
  return mesh
}
