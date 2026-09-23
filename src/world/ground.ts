/**
 * world/ground.ts — сетка земли поляны и её материал.
 *
 * Высоту даёт `terrain.ts`, здесь её только раскладывают по вершинам. Сетка
 * неравномерная: густая на поляне, где игрок ходит и где лежат волны грязи,
 * редкая за краем, где землю и так съедает туман. Возле вмятины пролога
 * сетка гуще ещё раз: игрок видит её вблизи, обернувшись.
 *
 * Материал - один на всю землю. Что где лежит, приходит атрибутом вершины
 * `wet` (0 - просто мокрая грязь, 0.5 - тропа, 1 - лужа), и по нему шейдер
 * решает шероховатость и рябь. Лужа - не отдельный предмет, а ровный срез
 * низины (terrain.ts): две плоскости в одном месте дали бы мерцание.
 */

import * as THREE from 'three'
import { CANOPY, CLEARING } from './layout'
import { heightAt, trailAt, waterDepth } from './terrain'
import { RAIN_TIME } from './shared'

/** Запас земли за краем поляны: край прячет туман. */
const MARGIN = 30

/** Шаг сетки: на поляне и у вмятины пролога. */
const FINE = 0.4
const DETAIL = 0.2

/** Где сетка гуще всего: окно вокруг вмятины пролога. */
const DETAIL_X: readonly [number, number] = [-5.6, -2.4]
const DETAIL_Z: readonly [number, number] = [22.6, 26.8]

/**
 * Альбедо грязи, линейное. Держим в середине: темноту делает туман и
 * экспозиция, а не чёрный материал (look.md, «Эталон кадра»).
 */
const MUD = new THREE.Color(0x5a5645)
const MUD_DARK = new THREE.Color(0x3b3b30)
const MUD_OLIVE = new THREE.Color(0x4f5a3c)

/** Координаты вдоль оси: густо внутри окна, редко снаружи, без повторов. */
function axis(from: number, to: number, fineFrom: number, fineTo: number, detail: readonly [number, number]): number[] {
  const out: number[] = []
  let v = from
  while (v < to) {
    out.push(v)
    const step = v >= detail[0] && v < detail[1] ? DETAIL : v >= fineFrom && v < fineTo ? FINE : 3
    // Ступень не перепрыгивает границу окна: иначе край окна уедет.
    let next = v + step
    for (const b of [fineFrom, fineTo, detail[0], detail[1]]) if (v < b && next > b) next = b
    v = next
  }
  out.push(to)
  return out
}

/** Детерминированный шум для пятен цвета: без него грязь - ровная заливка. */
function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return s - Math.floor(s)
}
function vnoise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = hash(ix, iz)
  const b = hash(ix + 1, iz)
  const c = hash(ix, iz + 1)
  const d = hash(ix + 1, iz + 1)
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}

export function buildGround(): THREE.Mesh {
  const xs = axis(CLEARING.minX - MARGIN, CLEARING.maxX + MARGIN, CLEARING.minX - 2, CLEARING.maxX + 2, DETAIL_X)
  const zs = axis(CLEARING.minZ - MARGIN, CLEARING.maxZ + MARGIN, CLEARING.minZ - 2, CLEARING.maxZ + 2, DETAIL_Z)
  const nx = xs.length
  const nz = zs.length

  const pos = new Float32Array(nx * nz * 3)
  const nor = new Float32Array(nx * nz * 3)
  const col = new Float32Array(nx * nz * 3)
  const wet = new Float32Array(nx * nz)
  const c = new THREE.Color()

  // Высоты - один проход, нормали - по соседям с настоящим шагом сетки:
  // шаг разный, и деление на него убирает полосы там, где он меняется.
  const h = new Float32Array(nx * nz)
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) h[iz * nx + ix] = heightAt(xs[ix], zs[iz])

  let i = 0
  for (let iz = 0; iz < nz; iz++) {
    const z = zs[iz]
    const za = zs[Math.max(0, iz - 1)]
    const zb = zs[Math.min(nz - 1, iz + 1)]
    for (let ix = 0; ix < nx; ix++, i++) {
      const x = xs[ix]
      const y = h[i]
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z

      const xa = xs[Math.max(0, ix - 1)]
      const xb = xs[Math.min(nx - 1, ix + 1)]
      const dhdx = (h[iz * nx + Math.min(nx - 1, ix + 1)] - h[iz * nx + Math.max(0, ix - 1)]) / (xb - xa)
      const dhdz = (h[Math.min(nz - 1, iz + 1) * nx + ix] - h[Math.max(0, iz - 1) * nx + ix]) / (zb - za)
      const inv = 1 / Math.hypot(dhdx, 1, dhdz)
      nor[i * 3] = -dhdx * inv
      nor[i * 3 + 1] = inv
      nor[i * 3 + 2] = -dhdz * inv

      const trail = trailAt(x, z)
      const water = waterDepth(x, z)
      // Под навесом сухо: дождь туда не достаёт.
      const sheltered = x > CANOPY.x0 && x < CANOPY.x1 && z > 0 && z < CANOPY.z1 - 0.2
      const puddle = water > 0.004 ? 1 : 0
      wet[i] = sheltered ? 0 : Math.max(puddle, trail * 0.55, 0.2)

      const n = vnoise(x * 0.35, z * 0.35) * 0.6 + vnoise(x * 1.7, z * 1.7) * 0.4
      c.copy(MUD).lerp(MUD_OLIVE, Math.max(0, n - 0.45) * 1.6)
      c.lerp(MUD_DARK, Math.min(1, trail * 0.85 + (1 - n) * 0.25))
      if (puddle) c.lerp(MUD_DARK, 0.6)
      col[i * 3] = c.r
      col[i * 3 + 1] = c.g
      col[i * 3 + 2] = c.b
    }
  }

  const index: number[] = []
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix
      const b = a + 1
      const d = a + nx
      const f = d + 1
      index.push(a, d, b, b, d, f)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setAttribute('wet', new THREE.BufferAttribute(wet, 1))
  geo.setIndex(nx * nz > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1))
  geo.computeBoundingSphere()

  const mesh = new THREE.Mesh(geo, groundMaterial())
  mesh.name = 'ground'
  mesh.receiveShadow = true
  return mesh
}

/**
 * Мокрая грязь. Три состояния одним шейдером по атрибуту `wet`:
 * грязь - шероховатость 0.6 и альбедо чуть темнее; тропа - мокрее и глаже;
 * лужа - почти зеркало с рябью от капель. Рябь - кольца от ударов, по сетке
 * ячеек со своим случайным ритмом у каждой: одинаковых колец рядом нет.
 */
function groundMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = RAIN_TIME
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float wet;
         varying float vWet;
         varying vec2 vGroundXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWet = wet;
         vGroundXZ = position.xz;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         varying float vWet;
         varying vec2 vGroundXZ;
         float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         // Рябь: в каждой ячейке своё кольцо со своим ритмом.
         vec2 ripple(vec2 p) {
           vec2 acc = vec2(0.0);
           for (int k = 0; k < 2; k++) {
             vec2 q = p * (k == 0 ? 3.1 : 4.3) + float(k) * 7.3;
             vec2 cell = floor(q);
             for (int j = -1; j <= 1; j++)
             for (int i = -1; i <= 1; i++) {
               vec2 id = cell + vec2(i, j);
               float h = gHash(id);
               vec2 c = id + vec2(gHash(id + 3.1), gHash(id + 5.7));
               float t = fract(uTime * (0.9 + h) + h * 7.0);
               vec2 d = q - c;
               float r = length(d);
               float ring = sin(clamp((r - t * 0.9) * 28.0, -3.1416, 3.1416)) * (1.0 - t) * smoothstep(0.9, 0.0, r);
               acc += d / max(r, 1e-3) * ring;
             }
           }
           return acc * 0.25;
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // Мокрое темнее сухого: альбедо на горизонталях x0.6 (look.md, «Мокрое»).
         diffuseColor.rgb *= mix(1.0, 0.6, clamp(vWet * 1.6, 0.0, 1.0));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = mix(0.72, 0.34, clamp(vWet * 1.8, 0.0, 1.0));
         float puddle = smoothstep(0.85, 0.98, vWet);
         roughnessFactor = mix(roughnessFactor, 0.06, puddle);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         if (puddle > 0.0) {
           vec2 rp = ripple(vGroundXZ) * puddle;
           normal = normalize(normal + (viewMatrix * vec4(rp.x, 0.0, rp.y, 0.0)).xyz);
         }`,
      )
  }
  return mat
}
