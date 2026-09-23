/**
 * world/index.ts — сборка мира.
 *
 * Сейчас это заготовка: земля поляны, болванка поста простыми объёмами и
 * лампа над дверью. Числа болванки - настоящие, из `layout.ts`, поэтому
 * силуэт, свет лампы и дерево коллизий уже стоят там, где будут стоять;
 * меняться будет форма, а не место.
 *
 * Мир собирается синхронно и без сети: ни одного файла, всё кодом.
 */

import * as THREE from 'three'
import { BODY } from '../player'
import { heightAt } from './terrain'
import { BLOCK, CANOPY, CLEARING, ENTRY_LAMP, HANGAR, PLINTH, WAKE_POINT } from './layout'

export type World = {
  /** Всё, что рисуется. */
  group: THREE.Group
  /** То, во что упирается тело: уходит в дерево коллизий. Земли тут нет - она формулой. */
  solid: THREE.Group
  /** Где стоят ступни в начале. */
  spawn: THREE.Vector3
  /** Куда смотреть, когда взгляд поднялся: на лампу. */
  yaw: number
  pitch: number
}

/**
 * Запас земли за краем поляны. Край прячет туман: на таком расстоянии он
 * съедает цвет почти целиком, и конец плоскости не читается.
 */
const GROUND_MARGIN = 30

/**
 * Альбедо держим в середине, а темноту делаем туманом и экспозицией: чёрный
 * материал в ночном кадре не даёт ни силуэта, ни отсвета.
 */
const MUD = 0x5f5c4a
const CONCRETE = 0x7d857f

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat)
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  return mesh
}

/** Свод ангара: половина эллиптического цилиндра вдоль X, от стен до гребня. */
function vault(mat: THREE.Material): THREE.Mesh {
  const length = HANGAR.x1 - HANGAR.x0
  const half = (HANGAR.z1 - HANGAR.z0) / 2
  const rise = HANGAR.ridge - HANGAR.wall
  // Цилиндр three стоит по Y; после поворота на четверть оборота вокруг Z его
  // ось идёт по X, а верхняя половина сечения - это углы от 0 до π.
  const geo = new THREE.CylinderGeometry(1, 1, length, 32, 1, false, 0, Math.PI)
  geo.rotateZ(Math.PI / 2)
  geo.scale(1, rise, half)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set((HANGAR.x0 + HANGAR.x1) / 2, HANGAR.wall, (HANGAR.z0 + HANGAR.z1) / 2)
  return mesh
}

function lamp(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'entry-lamp'
  const x = (ENTRY_LAMP.x0 + ENTRY_LAMP.x1) / 2
  const length = ENTRY_LAMP.x1 - ENTRY_LAMP.x0

  // Трубка светится сама: цвет выше единицы нужен, чтобы после тонмаппинга
  // она оставалась самым ярким в кадре.
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x6cb398).multiplyScalar(2.5), fog: false })
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(ENTRY_LAMP.radius, ENTRY_LAMP.radius, length, 12), glow)
  tube.rotation.z = Math.PI / 2
  tube.position.set(x, ENTRY_LAMP.y, ENTRY_LAMP.z)
  group.add(tube)

  // Свет лампы - прожектор вниз и вперёд, на отмостку и поляну перед дверью.
  const light = new THREE.SpotLight(0x6cb398, 25, 0, 1.15, 0.65, 2)
  light.position.set(x, ENTRY_LAMP.y - 0.05, ENTRY_LAMP.z + 0.08)
  light.target.position.set(x, 0, 5)
  group.add(light, light.target)
  return group
}

export function buildWorld(): World {
  const group = new THREE.Group()
  group.name = 'world'

  const mud = new THREE.MeshStandardMaterial({ color: MUD, roughness: 1 })
  const concrete = new THREE.MeshStandardMaterial({ color: CONCRETE, roughness: 0.92 })

  const w = CLEARING.maxX - CLEARING.minX + GROUND_MARGIN * 2
  const d = CLEARING.maxZ - CLEARING.minZ + GROUND_MARGIN * 2
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mud)
  ground.rotation.x = -Math.PI / 2
  ground.position.set((CLEARING.minX + CLEARING.maxX) / 2, 0, (CLEARING.minZ + CLEARING.maxZ) / 2)
  ground.name = 'ground'

  const solid = new THREE.Group()
  solid.name = 'solid'
  solid.add(
    box(BLOCK.x0, BLOCK.x1, 0, BLOCK.height, BLOCK.z0, BLOCK.z1, concrete),
    box(HANGAR.x0, HANGAR.x1, 0, HANGAR.wall, HANGAR.z0, HANGAR.z1, concrete),
    vault(concrete),
    box(CANOPY.x0, CANOPY.x1, CANOPY.y, CANOPY.y + CANOPY.thick, CANOPY.z0, CANOPY.z1, concrete),
    box(PLINTH.x0, PLINTH.x1, 0, PLINTH.top, PLINTH.z0, PLINTH.z1, concrete),
  )

  // Слабый свет неба: без него силуэт поста в тумане пропадает целиком.
  const sky = new THREE.HemisphereLight(0x113537, 0x050b0a, 0.6)

  group.add(ground, solid, lamp(), sky)

  const spawn = new THREE.Vector3(WAKE_POINT.x, heightAt(WAKE_POINT.x, WAKE_POINT.z), WAKE_POINT.z)

  // Камера three смотрит в -Z; поворот на yaw вокруг Y даёт направление
  // (-sin yaw, 0, -cos yaw). Отсюда угол на центр трубки.
  const dx = (ENTRY_LAMP.x0 + ENTRY_LAMP.x1) / 2 - spawn.x
  const dz = ENTRY_LAMP.z - spawn.z
  const yaw = Math.atan2(-dx, -dz)
  const pitch = Math.atan2(ENTRY_LAMP.y - (spawn.y + BODY.eye), Math.hypot(dx, dz))

  return { group, solid, spawn, yaw, pitch }
}
