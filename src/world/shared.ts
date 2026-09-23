/**
 * world/shared.ts — общие юниформы мира: время дождя, свет лампы входа,
 * вспышка молнии.
 *
 * Шейдеры листвы, луж, капель и бетона читают одни и те же числа, и держать
 * их копиями в каждом материале значило бы однажды разъехаться: лампа
 * погасла, а зелёная завеса дождя перед дверью светится дальше. Объекты
 * юниформ здесь одни на весь мир, и погода пишет в них раз в кадр.
 */

import * as THREE from 'three'
import { ENTRY_LAMP } from './layout'

/** Секунды с начала мира: по ним капает, рябит и кивает листва. */
export const RAIN_TIME = { value: 0 }

/**
 * Лампа входа для шейдеров, которые не берут свет сцены (капли, отсвет на
 * низе навеса). Отрезок трубки, цвет и сила: сила 0 - лампа погашена.
 */
export const LAMP = {
  a: { value: new THREE.Vector3(ENTRY_LAMP.x0, ENTRY_LAMP.y, ENTRY_LAMP.z) },
  b: { value: new THREE.Vector3(ENTRY_LAMP.x1, ENTRY_LAMP.y, ENTRY_LAMP.z) },
  color: { value: new THREE.Color(0x6cb398) },
  power: { value: 1 },
}

/** Вспышка молнии 0..1: небо, отсвет, светлеющий туман. */
export const FLASH = { value: 0 }

/** Кусок GLSL: расстояние от точки до отрезка трубки лампы. */
export const LAMP_GLSL = /* glsl */ `
  uniform vec3 uLampA;
  uniform vec3 uLampB;
  uniform vec3 uLampColor;
  uniform float uLampPower;
  float lampDistance(vec3 p) {
    vec3 ab = uLampB - uLampA;
    float t = clamp(dot(p - uLampA, ab) / dot(ab, ab), 0.0, 1.0);
    return length(p - (uLampA + ab * t));
  }
`

/** Подключить юниформы лампы к шейдеру. */
export function lampUniforms(uniforms: Record<string, THREE.IUniform>): void {
  uniforms.uLampA = LAMP.a
  uniforms.uLampB = LAMP.b
  uniforms.uLampColor = LAMP.color
  uniforms.uLampPower = LAMP.power
}
