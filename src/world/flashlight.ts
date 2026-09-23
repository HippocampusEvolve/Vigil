/**
 * world/flashlight.ts — фонарь, упавший в грязь рядом с местом пролога.
 *
 * Лежит у ног и светит вдоль кабелей на пост: по этому лучу игрок и идёт к
 * свету. Свет - прожектор тёплого белого без тени (тень снаружи одна, у лампы
 * входа), и поддельный видимый конус: в ливне луч виден, а объёмного света
 * у нас нет и не будет - конус рисуется аддитивным шейдером с медленным
 * шумом морося. Капли в конусе светлее - это считает шейдер дождя по тем же
 * числам (`TORCH` в rain.ts).
 *
 * Взять фонарь в руку - этап рук; здесь он только лежит и светит.
 */

import * as THREE from 'three'
import { FLASHLIGHT_REST } from './layout'
import { heightAt } from './terrain'
import { TORCH } from '../weather/rain'

/** Числа луча: look.md, «Фонарь». */
export const BEAM = {
  color: 0xffe2c0,
  /** Полуугол конуса, рад. */
  angle: (22 * Math.PI) / 180,
  penumbra: 0.6,
  distance: 18,
  decay: 2,
  intensity: 5,
  /** Видимый конус: длина и сила. */
  coneLength: 7,
  coneGain: 0.03,
} as const

export type Flashlight = {
  group: THREE.Group
  light: THREE.SpotLight
  setPower(k: number): void
}

export function buildFlashlight(): Flashlight {
  const group = new THREE.Group()
  group.name = 'flashlight'
  const x = FLASHLIGHT_REST.x
  const z = FLASHLIGHT_REST.z
  const dir = new THREE.Vector3(FLASHLIGHT_REST.aimX - x, 0, FLASHLIGHT_REST.aimZ - z).normalize()
  // Лежит в грязи на боку, чуть задрав голову: корпус просел, линза над землёй.
  const y = heightAt(x, z) + 0.02
  const tilt = 0.035

  const body = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d2b, roughness: 0.45, metalness: 0.6 })
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.17, 12), metal)
  handle.position.y = -0.085
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.02, 0.07, 14), metal)
  head.position.y = 0.035
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.027, 16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(BEAM.color).multiplyScalar(4) }),
  )
  lens.position.y = 0.0705
  lens.rotation.x = -Math.PI / 2
  body.add(handle, head, lens)
  // Ось цилиндра three - +Y; разворачиваем её по лучу.
  const axis = dir.clone().setY(Math.sin(tilt)).normalize()
  body.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis)
  body.position.set(x, y, z)
  group.add(body)

  const tip = new THREE.Vector3(x, y, z).addScaledVector(axis, 0.075)
  const light = new THREE.SpotLight(BEAM.color, BEAM.intensity, BEAM.distance, BEAM.angle, BEAM.penumbra, BEAM.decay)
  light.name = 'flashlight-beam'
  light.position.copy(tip)
  light.target.position.copy(tip).addScaledVector(axis, 5)
  light.castShadow = false
  group.add(light, light.target)

  // Видимый конус: открытый конус от линзы, яркость падает к концу и к краю.
  const cone = new THREE.ConeGeometry(Math.tan(BEAM.angle) * BEAM.coneLength * 0.8, BEAM.coneLength, 24, 8, true)
  cone.translate(0, -BEAM.coneLength / 2, 0)
  cone.rotateX(Math.PI)
  const coneMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uGain: { value: BEAM.coneGain }, uTime: { value: 0 } }]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying vec3 vWorld;
      void main() {
        vAlong = position.y / ${BEAM.coneLength.toFixed(1)};
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        vNormalV = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        vFogDepth = - mvPosition.z;
        vFogWorld = world.xyz;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uGain;
      uniform float uTime;
      varying float vAlong;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying vec3 vWorld;
      float h3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        // Край конуса тает: у силуэта луча свет рассеян тоньше всего.
        float rim = pow(abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.5);
        float fall = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.6);
        float mist = 0.75 + 0.25 * h3(floor(vWorld * 6.0 + vec3(0.0, uTime * 2.0, 0.0)));
        vec3 c = vec3(1.0, 0.886, 0.753) * uGain * rim * fall * mist;
        #ifdef USE_FOG
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          c *= 1.0 - fogFactor;
        #endif
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  })
  const beam = new THREE.Mesh(cone, coneMat)
  beam.name = 'flashlight-cone'
  beam.position.copy(tip)
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis)
  group.add(beam)

  TORCH.pos.value.copy(tip)
  TORCH.dir.value.copy(axis)
  TORCH.cos.value = Math.cos(BEAM.angle)
  TORCH.power.value = 1

  return {
    group,
    light,
    setPower(k) {
      light.intensity = BEAM.intensity * k
      coneMat.uniforms.uGain.value = BEAM.coneGain * k
      TORCH.power.value = k
    },
  }
}
