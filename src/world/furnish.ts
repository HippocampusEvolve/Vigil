/**
 * world/furnish.ts — предметы нутра: что из каталога ядра где стоит и чем
 * покрашено.
 *
 * Предмет попадает в мир только через каталог ядра `world-core/props`
 * (docs/architecture.md, «Каталог»): мир не собирает мебель у себя, он её
 * расставляет. Каталог отдаёт группу мешей с материалами по ролям; мир
 * подменяет каждую роль своей краской (`paint`, `wood`, `glass`...) и
 * сливает всё неподвижное по комнатам в три меша: непрозрачное, стекло и
 * свечение. Полсотни предметов по десятку деталей - это пятьсот вызовов
 * отрисовки, а после слияния - три на комнату.
 *
 * Роль, которой нет в словаре мира, - ошибка сборки, а не молчаливая подмена
 * соседней краской (правило каталога). Подвижные детали (`userData.moving`)
 * остаются отдельными мешами: их двигают этапы рук и сценария.
 *
 * Краски - одна программа на всё непрозрачное: вид поверхности едет атрибутом
 * вершины (`surf`: шероховатость, металл, порода, светильник), а не отдельным
 * материалом на каждую породу.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { box, merge } from './geom'
import { indoor } from './indoor'
import { NOISE_GLSL } from './concrete'
import { FIXTURES, zoneAt, type FixtureId, type RoomId } from './zones'

/** Породы поверхности: номер уезжает в шейдер атрибутом. */
export const KIND = {
  paint: 0,
  steel: 1,
  rust: 2,
  wood: 3,
  cloth: 4,
  rubber: 5,
  enamel: 6,
  paper: 7,
  plastic: 8,
  brass: 9,
  soil: 10,
  leaf: 11,
  fruit: 12,
  photo: 13,
} as const
export type Kind = keyof typeof KIND

/** Шероховатость и металл по породе: отправные, цвет - у роли. */
const SURF: Record<Kind, [number, number]> = {
  paint: [0.62, 0.15],
  steel: [0.42, 0.75],
  rust: [0.85, 0.25],
  wood: [0.72, 0],
  cloth: [0.95, 0],
  rubber: [0.8, 0],
  enamel: [0.28, 0],
  paper: [0.9, 0],
  plastic: [0.5, 0],
  brass: [0.34, 0.85],
  soil: [0.98, 0],
  leaf: [0.7, 0],
  fruit: [0.35, 0],
  photo: [0.55, 0],
}

/** Что светится: трубка, лампа, экран, шкала, огонёк, абажур. */
export type GlowRole = 'tube' | 'bulb' | 'screen' | 'dial' | 'led' | 'shade'

/**
 * Краска роли: порода и цвет, или свечение - цвет, сила и светильник, за
 * силой которого оно идёт (без светильника горит ровно). Прозрачное -
 * стекло и вода.
 */
export type Look =
  | { kind: Kind; color: number }
  | { glass: true; color: number; opacity?: number }
  | { glow: GlowRole; color: number; strength: number; fixture?: FixtureId }

/** Метка роли: материал-пустышка, по которому слияние узнаёт краску детали. */
type Marker = THREE.MeshBasicMaterial & { userData: { look: Look; role: string; prop: string } }

/**
 * Материалы по ролям для предмета каталога. Каждая роль обязана быть в
 * словаре `looks`; чужая роль - ошибка, с именем предмета и роли.
 */
export function mats(prop: string, looks: Record<string, Look>): Record<string, THREE.Material> {
  const cache = new Map<string, Marker>()
  return new Proxy({} as Record<string, THREE.Material>, {
    get(_t, role) {
      if (typeof role !== 'string') return undefined
      const look = looks[role]
      if (!look) throw new Error(`furnish: у предмета «${prop}» нет краски для роли «${role}»`)
      let m = cache.get(role)
      if (!m) {
        m = new THREE.MeshBasicMaterial() as Marker
        m.userData = { look, role, prop }
        cache.set(role, m)
      }
      return m
    },
    has(_t, role) {
      return typeof role === 'string' && role in looks
    },
  })
}

// --- Слияние ---------------------------------------------------------------------

type Batch = { opaque: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[] }

/** Геометрия детали в мировых координатах с атрибутами краски. */
function prepare(mesh: THREE.Mesh, look: Look): THREE.BufferGeometry {
  mesh.updateMatrixWorld(true)
  let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
  g.applyMatrix4(mesh.matrixWorld)
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name)
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
  const n = g.getAttribute('position').count
  const col = new Float32Array(n * 3)
  const surf = new Float32Array(n * 4)
  const c = new THREE.Color(look.color)
  let r = 0.9
  let m = 0
  let kind = 0
  let extra = -1
  if ('kind' in look) {
    ;[r, m] = SURF[look.kind]
    kind = KIND[look.kind]
  } else if ('glow' in look) {
    c.multiplyScalar(look.strength)
    extra = look.fixture ? FIXTURES.findIndex((f) => f.id === look.fixture) : -1
  } else {
    r = 0.12
  }
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
    surf[i * 4] = r
    surf[i * 4 + 1] = m
    surf[i * 4 + 2] = kind
    surf[i * 4 + 3] = extra
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setAttribute('surf', new THREE.BufferAttribute(surf, 4))
  return g
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null
  const g = mergeGeometries(list, false)
  if (!g) throw new Error('furnish: детали с разными атрибутами')
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}

// --- Материалы ---------------------------------------------------------------------

/**
 * Непрозрачные краски одной программой. Порода даёт свою мелочь: краска
 * облуплена по кромкам до металла, дерево в волокне, ткань в пыли, на всём
 * горизонтальном - пыль.
 */
function propMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 })
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 surf;\nvarying vec4 vSurf;\nvarying vec3 vPW;\nvarying vec3 vPN;\nvarying vec2 vPUv;`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vSurf = surf;
         vPW = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vPN = normalize(mat3(modelMatrix) * objectNormal);
         vPUv = uv;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec4 vSurf;
         varying vec3 vPW;
         varying vec3 vPN;
         varying vec2 vPUv;
         ${NOISE_GLSL}
         float pRough;
         float pMetal;
         // Снимок в рамке: пять фигур на светлом, лица съедены плесенью.
         vec3 pPhoto(vec2 uv) {
           vec3 paper = vec3(0.55, 0.5, 0.42);
           float fig = 0.0;
           for (int i = 0; i < 5; i++) {
             float x = 0.14 + float(i) * 0.18;
             float head = 1.0 - smoothstep(0.045, 0.06, length((uv - vec2(x, 0.66)) * vec2(1.0, 0.8)));
             float body = (1.0 - smoothstep(0.07, 0.09, abs(uv.x - x))) * step(uv.y, 0.6) * step(0.12, uv.y);
             fig = max(fig, max(head, body));
           }
           vec3 c = mix(paper, vec3(0.12, 0.11, 0.1), fig * 0.8);
           float mold = smoothstep(0.5, 0.75, wFbm(vec3(uv * 9.0, 2.0))) * smoothstep(0.45, 0.7, uv.y);
           return mix(c, vec3(0.16, 0.2, 0.12), mold);
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           pRough = vSurf.x;
           pMetal = vSurf.y;
           float kind = vSurf.z;
           vec3 p = vPW;
           vec3 n = normalize(vPN);
           float big = wFbm(p * 1.7);
           float fine = wNoise(p * 31.0);
           vec3 c = diffuseColor.rgb;
           if (kind < 0.5) {
             // Краска: облупилась пятнами до металла, по кромкам больше.
             float chip = smoothstep(0.66, 0.7, wFbm(p * 6.3 + 5.0));
             c = mix(c * (0.85 + 0.25 * big), vec3(0.22, 0.2, 0.18), chip);
             pMetal = mix(pMetal, 0.6, chip);
             pRough = mix(pRough, 0.5, chip);
           } else if (kind < 1.5) {
             c *= 0.8 + 0.3 * big;
           } else if (kind < 2.5) {
             c *= 0.7 + 0.5 * big + 0.15 * (fine - 0.5);
           } else if (kind < 3.5) {
             // Дерево: волокно вдоль длинной стороны детали.
             float grain = wNoise(vec3(vPUv.x * 3.0, vPUv.y * 60.0, 1.0));
             c *= 0.78 + 0.35 * grain + 0.15 * big;
           } else if (kind < 4.5) {
             c *= 0.85 + 0.2 * big + 0.1 * (fine - 0.5);
           } else if (kind > 12.5) {
             c = pPhoto(vPUv);
           } else {
             c *= 0.9 + 0.15 * big;
           }
           // Пыль на горизонтальном: серее и светлее, у кромок меньше.
           float dust = smoothstep(0.6, 0.95, n.y) * (0.25 + 0.35 * big);
           c = mix(c, vec3(0.34, 0.33, 0.3), dust * step(kind, 9.5) * (1.0 - step(12.5, kind)));
           diffuseColor.rgb = c;
         }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = pRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = pMetal;')
  }
  mat.customProgramCacheKey = () => 'vigil-props'
  return indoor(mat)
}

function glassMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false })
  mat.customProgramCacheKey = () => 'vigil-props-glass'
  // Без света нутра, как стекло поста (post.ts, `postMaterials`): прозрачная
  // программа с нутром на программном GL собирается больше полусекунды одной
  // задачей, а на тёмном стекле свет комнат не читается.
  return mat
}

/**
 * Свечение: цвет вершины уже с силой; светильник (четвёртая компонента
 * `surf`) даёт мигание трубки - та же сила, что у её света и гула.
 */
function glowMaterial(power: { value: number[] }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uPower: power },
    vertexShader: /* glsl */ `
      attribute vec4 surf;
      varying vec3 vColor;
      varying float vFix;
      void main() {
        vColor = color;
        vFix = surf.w;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uPower[${FIXTURES.length}];
      varying vec3 vColor;
      varying float vFix;
      void main() {
        float p = 1.0;
        for (int i = 0; i < ${FIXTURES.length}; i++) if (abs(vFix - float(i)) < 0.5) p = uPower[i];
        // Погасшая трубка не чёрная: стекло и люминофор видны тусклым серым.
        vec3 off = vec3(0.035, 0.037, 0.036);
        gl_FragColor = vec4(max(vColor * p, off), 1.0);
      }
    `,
    vertexColors: true,
  })
}

// --- Расстановка ----------------------------------------------------------------------

export type Placed = {
  /** Имя в реестре: по нему этапы рук находят предмет. */
  name: string
  group: THREE.Group
  /** В какой комнате стоит. */
  room: RoomId
}

export type Furnish = {
  group: THREE.Group
  /** Все расставленные предметы по именам: их подвижные детали живут здесь. */
  placed: Map<string, Placed>
  /** Подвижные детали по имени предмета и детали. */
  moving: Map<string, THREE.Object3D>
  /** Твёрдое: рамки предметов, до которых достаёт тело. */
  colliders: THREE.BufferGeometry
  /** Тела для проверки наложений: деталь за деталью, в мировых координатах. */
  bodies: Array<{ name: string; geometry: THREE.BufferGeometry }>
}

/** Одна расстановка: предмет из каталога, где стоит, повёрнут ли, твёрд ли. */
export type Item = {
  name: string
  make: () => THREE.Group
  at: [number, number, number]
  /** Поворот вокруг Y, рад. */
  yaw?: number
  /** Твёрдый для тела: рамкой по габаритам. */
  solid?: boolean
}

/** Выше этой отметки над полом предмет телу не мешает. */
const REACH = 1.8

/**
 * Предметы нутра, по комнатам. Заполняется из каталога ядра (`PLACEMENT`
 * ниже); пустой список - нутро без обстановки, коробка и свет всё равно
 * работают.
 */
export const PLACEMENT: Item[] = []

export function* furnishSteps(_materials: { concrete: THREE.Material; metal: THREE.Material; glass: THREE.Material }, items: Item[] = PLACEMENT, power?: { value: number[] }): Generator<void, Furnish, void> {
  const group = new THREE.Group()
  group.name = 'furnish'
  const placed = new Map<string, Placed>()
  const moving = new Map<string, THREE.Object3D>()
  const batches = new Map<RoomId, Batch>()
  const solid: THREE.BufferGeometry[] = []
  const bodies: Array<{ name: string; geometry: THREE.BufferGeometry }> = []
  const opaqueMat = propMaterial()
  const glassMat = glassMaterial()
  const glowMat = glowMaterial(power ?? { value: FIXTURES.map(() => 1) })

  let spent = performance.now()
  for (const item of items) {
    const g = item.make()
    g.name = item.name
    g.position.set(...item.at)
    g.rotation.y = item.yaw ?? 0
    g.updateMatrixWorld(true)
    const room = zoneAt(item.at[0], item.at[1] + 0.3, item.at[2])
    if (room === 'out') throw new Error(`furnish: «${item.name}» стоит снаружи (${item.at.join(', ')})`)
    placed.set(item.name, { name: item.name, group: g, room })
    let batch = batches.get(room)
    if (!batch) batches.set(room, (batch = { opaque: [], glass: [], glow: [] }))
    // Рамка - до слияния, пока все детали на месте.
    if (item.solid) {
      const bb = new THREE.Box3().setFromObject(g)
      if (bb.min.y < item.at[1] + REACH) solid.push(box(bb.min.x, bb.max.x, bb.min.y, bb.max.y, bb.min.z, bb.max.z))
    }
    const own: THREE.BufferGeometry[] = []
    const keep: THREE.Object3D[] = []
    g.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      // Подвижная деталь (или внутри подвижной группы) остаётся мешем.
      let movingRoot: THREE.Object3D | null = null
      for (let q: THREE.Object3D | null = mesh; q && q !== g; q = q.parent) if (q.userData.moving) movingRoot = q
      const marker = mesh.material as Marker
      const look = marker.userData?.look
      if (!look) throw new Error(`furnish: у детали «${item.name}/${mesh.name}» материал не из словаря мира`)
      const geo = prepare(mesh, look)
      own.push(geo)
      if (movingRoot) {
        keep.push(mesh)
        moving.set(`${item.name}/${movingRoot.userData.moving}`, movingRoot)
        // Деталь в своём месте иерархии, но с краской мира: своя геометрия с атрибутами.
        const local = prepare(new THREE.Mesh(mesh.geometry, marker), look)
        mesh.geometry = local
        mesh.material = 'glass' in look ? glassMat : 'glow' in look ? glowMat : opaqueMat
        return
      }
      if ('glass' in look) batch.glass.push(geo)
      else if ('glow' in look) batch.glow.push(geo)
      else batch.opaque.push(geo)
    })
    // Подвижные части остаются в группе предмета; неподвижное ушло в слияние.
    const strip: THREE.Object3D[] = []
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !keep.includes(o)) strip.push(o)
    })
    for (const o of strip) o.parent?.remove(o)
    if (keep.length) group.add(g)
    // Тело для проверки наложений - предмет целиком: детали внутри предмета
    // проверяет каталог, мир спрашивает, не вошёл ли предмет в стену или в соседа.
    const whole = mergeAll(own)
    if (whole) bodies.push({ name: item.name, geometry: whole })
    if (performance.now() - spent > 12) {
      yield
      spent = performance.now()
    }
  }

  for (const [room, b] of batches) {
    const parts: Array<[THREE.BufferGeometry | null, THREE.Material, string]> = [
      [mergeAll(b.opaque), opaqueMat, 'props'],
      [mergeAll(b.glass), glassMat, 'props-glass'],
      [mergeAll(b.glow), glowMat, 'props-glow'],
    ]
    for (const [geo, mat, name] of parts) {
      if (!geo) continue
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = `${name}-${room}`
      mesh.castShadow = name === 'props'
      mesh.receiveShadow = name !== 'props-glow'
      group.add(mesh)
    }
    yield
  }

  return { group, placed, moving, colliders: merge(solid), bodies }
}
