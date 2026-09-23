/**
 * world/index.ts — сборка мира по шагам.
 *
 * Мир собирается синхронно и без сети, но не одним куском: каждый шаг -
 * отдельная задача главного потока, между шагами браузер свободен. Самая
 * долгая задача входа обязана укладываться в 60 мс (docs/architecture.md,
 * «Рамки»), а лес, земля и пост одним куском в неё не влезают.
 *
 * Поэтому сборка - генератор: `buildWorldSteps()` отдаёт имя очередного шага,
 * а тот, кто её ведёт (main.ts), решает, когда звать следующий. Лес рисует
 * атлас на канве, поэтому целиком мир собирается только в браузере; проверки
 * на Node берут его куски по отдельности (пост, план леса, кабели, края).
 */

import * as THREE from 'three'
import { BODY } from '../player'
import { heightAt } from './terrain'
import { buildGround } from './ground'
import { buildPost, type Post } from './post'
import { planForest, type ForestPlan } from './forest-plan'
import { buildForest, type Forest } from './forest'
import { buildCables } from './cables'
import { buildBounds } from './bounds'
import { buildFlashlight, type Flashlight } from './flashlight'
import { ENTRY_LAMP, FOCUS_FOV, LAMP_IN_FRAME, WAKE_POINT } from './layout'
import { LAMP } from './shared'

export type World = {
  /** Всё, что рисуется. */
  group: THREE.Group
  /** То, во что упирается тело: уходит в дерево коллизий. Земли тут нет - она формулой. */
  solid: THREE.Group
  /** Где стоят ступни в начале. */
  spawn: THREE.Vector3
  /** Куда смотреть, когда взгляд поднялся: лампа в своей точке кадра. */
  yaw: number
  pitch: number
  plan: ForestPlan
  post: Post
  forest: Forest
  flashlight: Flashlight
  lamp: THREE.SpotLight
  /** Перекадрировать взгляд под новое соотношение сторон экрана. */
  aim(aspect: number): { yaw: number; pitch: number }
}

/** Лампа входа: числа света - look.md, «Лампа входа». */
export const LAMP_LIGHT = {
  color: 0x6cb398,
  intensity: 105,
  /** Полуугол конуса, рад: широкий, как у трубки под навесом. */
  angle: (70 * Math.PI) / 180,
  penumbra: 0.35,
  distance: 12,
  decay: 2,
  shadow: 512,
} as const

function buildLamp(): THREE.SpotLight {
  const x = (ENTRY_LAMP.x0 + ENTRY_LAMP.x1) / 2
  const light = new THREE.SpotLight(
    LAMP_LIGHT.color,
    LAMP_LIGHT.intensity,
    LAMP_LIGHT.distance,
    LAMP_LIGHT.angle,
    LAMP_LIGHT.penumbra,
    LAMP_LIGHT.decay,
  )
  light.name = 'entry-lamp'
  // Из-под трубки вниз-вперёд: на дверь, отмостку и поляну перед входом.
  light.position.set(x, ENTRY_LAMP.y - 0.04, ENTRY_LAMP.z + 0.05)
  light.target.position.set(x, 0, ENTRY_LAMP.z + 1.4)
  light.castShadow = true
  light.shadow.mapSize.set(LAMP_LIGHT.shadow, LAMP_LIGHT.shadow)
  light.shadow.camera.near = 0.1
  light.shadow.camera.far = LAMP_LIGHT.distance
  light.shadow.bias = -0.0008
  light.shadow.normalBias = 0.02
  return light
}

/**
 * Взгляд, при котором лампа ложится в `LAMP_IN_FRAME`: доли ширины и высоты
 * кадра. Считается проекцией настоящей камеры, а не формулой углов: при
 * повороте головы вбок вертикаль в перспективе тоже уезжает.
 */
export function aimAtLamp(spawn: THREE.Vector3, aspect: number, fov: number = FOCUS_FOV): { yaw: number; pitch: number } {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 100)
  cam.position.set(spawn.x, spawn.y + BODY.eye, spawn.z)
  cam.rotation.order = 'YXZ'
  const lamp = new THREE.Vector3((ENTRY_LAMP.x0 + ENTRY_LAMP.x1) / 2, ENTRY_LAMP.y, ENTRY_LAMP.z)
  const want = new THREE.Vector2(LAMP_IN_FRAME.x * 2 - 1, 1 - LAMP_IN_FRAME.y * 2)
  const dx = lamp.x - cam.position.x
  const dz = lamp.z - cam.position.z
  let yaw = Math.atan2(-dx, -dz)
  let pitch = Math.atan2(lamp.y - cam.position.y, Math.hypot(dx, dz))
  const p = new THREE.Vector3()
  // Несколько шагов Ньютона по двум углам: сходится за три-четыре.
  for (let i = 0; i < 8; i++) {
    cam.rotation.set(pitch, yaw, 0)
    cam.updateMatrixWorld()
    p.copy(lamp).project(cam)
    const ex = p.x - want.x
    const ey = p.y - want.y
    if (Math.abs(ex) < 1e-5 && Math.abs(ey) < 1e-5) break
    const h = 1e-4
    cam.rotation.set(pitch, yaw + h, 0)
    cam.updateMatrixWorld()
    const px = p.clone().copy(lamp).project(cam)
    cam.rotation.set(pitch + h, yaw, 0)
    cam.updateMatrixWorld()
    const py = lamp.clone().project(cam)
    const j11 = (px.x - p.x) / h
    const j21 = (px.y - p.y) / h
    const j12 = (py.x - p.x) / h
    const j22 = (py.y - p.y) / h
    const det = j11 * j22 - j12 * j21
    yaw -= (ex * j22 - ey * j12) / det
    pitch -= (ey * j11 - ex * j21) / det
  }
  return { yaw, pitch }
}

/**
 * Шаги сборки. Порядок - от того, что видно первым кадром, к тому, что нужно
 * только телу: земля и пост, потом лес, потом всё мелкое и невидимое.
 */
export function* buildWorldSteps(aspect: number): Generator<string, World, void> {
  const group = new THREE.Group()
  group.name = 'world'
  const solid = new THREE.Group()
  solid.name = 'solid'

  group.add(buildGround())
  yield 'земля'

  const post = buildPost()
  group.add(post.group)
  for (const o of post.solid) solid.add(o.clone())
  const lamp = buildLamp()
  group.add(lamp, lamp.target)
  LAMP.power.value = 1
  yield 'пост'

  const plan = planForest()
  yield 'план леса'

  const forest = buildForest(plan)
  group.add(forest.group)
  yield 'лес'

  group.add(buildCables())
  const flashlight = buildFlashlight()
  group.add(flashlight.group)
  for (const m of buildBounds(plan)) solid.add(m)
  yield 'кабели'

  const spawn = new THREE.Vector3(WAKE_POINT.x, heightAt(WAKE_POINT.x, WAKE_POINT.z), WAKE_POINT.z)
  const { yaw, pitch } = aimAtLamp(spawn, aspect)
  return {
    group,
    solid,
    spawn,
    yaw,
    pitch,
    plan,
    post,
    forest,
    flashlight,
    lamp,
    aim: (a) => aimAtLamp(spawn, a),
  }
}
