/**
 * world/forest.ts — лес по плану (forest-plan.ts): стволы, листва, лианы.
 *
 * Лес - главный объём кадра, и почти весь он силуэт в тумане. Поэтому
 * устройство простое и дешёвое: стволы - один слитый меш с цветом вершин,
 * листва - карточки с альфа-срезом из атласа (leaves.ts), по одному
 * инстансному мешу на вид. Десяток вызовов отрисовки на весь лес.
 *
 * Дождь шевелит листву: вершинный шейдер даёт листу короткий случайный кивок,
 * как от удара капли. Это почти ничего не стоит и продаёт ливень лучше
 * частиц (look.md, «Лес»). Сила кивка растёт к кончику листа - атрибут
 * `sway`, 0 у черешка и 1 на конце.
 */

import * as THREE from 'three'
import { rng } from './geom'
import { cellUV, leafAtlas, type LeafKind } from './leaves'
import type { ForestPlan, Plant, PlantKind, Trunk } from './forest-plan'
import { RAIN_TIME } from './shared'

/** Лист-карточка вдоль дуги: основание в нуле, растёт по +X и вверх. */
type BladeOpts = {
  cell: LeafKind
  length: number
  width: number
  /** Угол подъёма у основания, рад. */
  pitch: number
  /** Насколько кончик провисает ниже прямой, м. */
  droop: number
  /** Поворот вокруг вертикали, рад. */
  yaw: number
  /** Высота основания. */
  y0?: number
  /** Поперечный изгиб: лист - желобок, а не доска. */
  fold?: number
  segments?: number
}

class Builder {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  sway: number[] = []
  index: number[] = []

  /** Лист, вайя, перо пальмы: лента вдоль дуги. */
  blade(o: BladeOpts): void {
    const seg = o.segments ?? 5
    const [u0, v0, u1, v1] = cellUV(o.cell)
    const cy = Math.cos(o.yaw)
    const sy = Math.sin(o.yaw)
    const base = this.pos.length / 3
    // Желобок: края листа приподняты над средней жилкой, лист не доска.
    const lift = (o.fold ?? 0.12) * o.width * 0.5
    for (let i = 0; i <= seg; i++) {
      const t = i / seg
      const along = o.length * t * Math.cos(o.pitch)
      const up = (o.y0 ?? 0) + o.length * t * Math.sin(o.pitch) - o.droop * t * t
      // Касательная дуги для нормали: производная по t.
      const dAlong = Math.cos(o.pitch)
      const dUp = Math.sin(o.pitch) - (2 * o.droop * t) / o.length
      const nl = Math.hypot(dAlong, dUp)
      for (const side of [-1, 1]) {
        const w = (o.width / 2) * side
        this.pos.push(along * cy - w * sy, up + lift * t, along * sy + w * cy)
        // Нормаль ленты - вверх от неё, с наклоном по дуге.
        this.nor.push((-dUp / nl) * cy, dAlong / nl, (-dUp / nl) * sy)
        this.uv.push(side < 0 ? u0 : u1, v0 + (v1 - v0) * t)
        this.sway.push(t)
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2
      this.index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }

  /** Вертикальная карточка: пучок травы, клок кроны. `hang` - свисает вниз. */
  card(cell: LeafKind, width: number, height: number, yaw: number, hang = false, bend = 0): void {
    const [u0, v0, u1, v1] = cellUV(cell)
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const base = this.pos.length / 3
    const seg = hang ? 6 : 2
    for (let i = 0; i <= seg; i++) {
      const t = i / seg
      const y = hang ? -height * t : height * t
      const off = bend * t * t
      for (const side of [-1, 1]) {
        const x = (width / 2) * side
        this.pos.push(x * cy + off * sy, y, -x * sy + off * cy)
        this.nor.push(sy, 0, cy)
        // У свисающих ячеек атласа верх - точка подвеса.
        this.uv.push(side < 0 ? u0 : u1, hang ? v1 - (v1 - v0) * t : v0 + (v1 - v0) * t)
        this.sway.push(hang ? t : t * 0.8)
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2
      this.index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.sway, 1))
    g.setIndex(this.index)
    g.computeBoundingSphere()
    return g
  }
}

/** Образец растения: одна геометрия на вид, экземпляры её вращают и масштабируют. */
function plantGeometry(kind: PlantKind | 'palm', seed: number): THREE.BufferGeometry {
  const r = rng(seed)
  const b = new Builder()
  switch (kind) {
    case 'broad':
      // Банан и геликония: длинные листья дугой наружу из низкого ложного стебля.
      for (let i = 0; i < 7; i++) {
        b.blade({
          cell: 'broad',
          length: 1.0 + r() * 0.7,
          width: 0.4 + r() * 0.16,
          pitch: 0.55 + r() * 0.45,
          droop: 0.45 + r() * 0.45,
          yaw: (i / 7) * Math.PI * 2 + r() * 0.7,
          y0: 0.25 + r() * 0.45,
          segments: 6,
        })
      }
      break
    case 'split':
      for (let i = 0; i < 5; i++) {
        b.blade({
          cell: 'split',
          length: 0.75 + r() * 0.25,
          width: 0.7 + r() * 0.15,
          pitch: 0.75 + r() * 0.35,
          droop: 0.3 + r() * 0.15,
          yaw: (i / 5) * Math.PI * 2 + r() * 0.6,
          y0: 0.05,
          fold: 0.18,
        })
      }
      break
    case 'fern':
      for (let i = 0; i < 11; i++) {
        b.blade({
          cell: 'fern',
          length: 0.75 + r() * 0.35,
          width: 0.34 + r() * 0.08,
          pitch: 0.8 + r() * 0.45,
          droop: 0.45 + r() * 0.2,
          yaw: (i / 11) * Math.PI * 2 + r() * 0.4,
          fold: 0.05,
        })
      }
      break
    case 'grass':
      for (let i = 0; i < 3; i++) b.card('grass', 0.42, 0.45, (i * Math.PI) / 3 + r() * 0.3)
      break
    case 'palm':
      // Крона пальмы: перья дугой из одной точки.
      for (let i = 0; i < 13; i++) {
        b.blade({
          cell: 'palm',
          length: 2.6 + r() * 0.8,
          width: 1.0 + r() * 0.2,
          pitch: 0.35 + r() * 0.55,
          droop: 1.3 + r() * 0.6,
          yaw: (i / 13) * Math.PI * 2 + r() * 0.3,
          fold: 0.15,
          segments: 7,
        })
      }
      break
  }
  return b.geometry()
}

/**
 * Материал листвы: атлас с альфа-срезом, двусторонний, и кивок от капель.
 * Ламберт, а не физический: листьев тысячи, и на телефоне это заметно.
 */
function foliageMaterial(atlas: THREE.Texture, nod: number): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = RAIN_TIME
    shader.uniforms.uNod = { value: nod }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float sway;
         uniform float uTime;
         uniform float uNod;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           #ifdef USE_INSTANCING
             vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
           #else
             vec3 ip = vec3(0.0);
           #endif
           float ph = fract(sin(dot(ip.xz + position.xz * 0.7, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
           // Капля бьёт по листу: короткий острый кивок, у каждого листа свой ритм.
           float k = pow(max(0.0, sin(uTime * 2.1 + ph)), 16.0)
                   + 0.7 * pow(max(0.0, sin(uTime * 3.3 + ph * 1.9)), 22.0);
           transformed.y -= k * sway * sway * uNod;
           transformed.xz += vec2(sin(uTime * 0.6 + ph), cos(uTime * 0.5 + ph)) * sway * uNod * 0.25;
         }`,
      )
  }
  mat.customProgramCacheKey = () => `vigil-foliage-${nod}`
  return mat
}

/** Инстансный меш растений одного вида. */
function instanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  items: Array<{ x: number; y: number; z: number; scale: number; yaw: number; sy?: number }>,
  tint: (i: number) => THREE.Color,
  name: string,
): THREE.InstancedMesh {
  // Порядок перемешан: урезая листву на телефоне, срезаем по всему лесу
  // понемногу, а не целиком последнюю посадку.
  const r = rng(items.length * 31 + 7)
  items = items.slice()
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length))
  mesh.name = name
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const p = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  items.forEach((it, i) => {
    q.setFromAxisAngle(up, it.yaw)
    s.set(it.scale, it.sy ?? it.scale, it.scale)
    p.set(it.x, it.y, it.z)
    m.compose(p, q, s)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, tint(i))
  })
  mesh.count = items.length
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.computeBoundingSphere()
  mesh.frustumCulled = true
  return mesh
}

// --- Стволы -------------------------------------------------------------------

/** Кора: тёмная, у земли мокрая и в мху. Линейные цвета вершин. */
const BARK = new THREE.Color(0x4a4238)
const BARK_MOSS = new THREE.Color(0x3a4a2a)
const PALM_BARK = new THREE.Color(0x5a5244)

/**
 * Ствол вдоль слегка изогнутой оси, сужается к вершине. У исполина внизу
 * досковидные корни - тонкие вертикальные крылья, расходящиеся от ствола.
 */
function trunkGeometry(t: Trunk, out: { pos: number[]; nor: number[]; col: number[]; index: number[] }): void {
  const r = rng(t.seed * 7919)
  const radial = t.kind === 'giant' ? 14 : t.kind === 'palm' ? 8 : 7
  const rings = t.kind === 'giant' ? 10 : t.kind === 'palm' ? 8 : 5
  const taper = t.kind === 'giant' ? 0.45 : t.kind === 'palm' ? 0.7 : 0.5
  const c = new THREE.Color()
  const base = out.pos.length / 3
  for (let i = 0; i <= rings; i++) {
    const h = i / rings
    // Ось изгибается к наклону: к верху сильнее, как у дерева, тянущегося к свету.
    const ax = t.x + t.leanX * h * h
    const az = t.z + t.leanZ * h * h
    const y = t.y + t.height * h
    const rad = t.radius * (1 - (1 - taper) * h) * (t.kind === 'giant' ? 1 + 0.6 * Math.pow(1 - h, 8) : 1)
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2
      const wob = 1 + (r() - 0.5) * 0.08
      const nx = Math.cos(a)
      const nz = Math.sin(a)
      out.pos.push(ax + nx * rad * wob, y, az + nz * rad * wob)
      out.nor.push(nx, 0, nz)
      const moss = Math.max(0, 1 - (y - t.y) / 4) * (0.5 + 0.5 * Math.max(0, nz))
      c.copy(t.kind === 'palm' ? PALM_BARK : BARK).lerp(BARK_MOSS, moss * 0.8)
      out.col.push(c.r, c.g, c.b)
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * (radial + 1) + j
      const b2 = a + radial + 1
      out.index.push(a, b2, a + 1, a + 1, b2, b2 + 1)
    }
  }

  // Досковидные корни: крыло - вертикальный парус от ствола наружу, высота
  // падает к краю по дуге.
  for (let f = 0; f < t.fins; f++) {
    const a = (f / t.fins) * Math.PI * 2 + r() * 0.6
    const len = 2 + r() * 2
    const hgt = 2 + r() * 1.2
    const th = 0.09
    const nx = Math.cos(a)
    const nz = Math.sin(a)
    const px = -nz
    const pz = nx
    const seg = 6
    for (const side of [-1, 1]) {
      const b0 = out.pos.length / 3
      for (let i = 0; i <= seg; i++) {
        const s = i / seg
        const d = t.radius * 0.7 + len * s
        const top = t.y + 0.3 + hgt * Math.pow(1 - s, 2.2)
        const x = t.x + nx * d + px * th * side
        const z = t.z + nz * d + pz * th * side
        out.pos.push(x, t.y, z, x, top, z)
        out.nor.push(px * side, 0, pz * side, px * side, 0, pz * side)
        c.copy(BARK).lerp(BARK_MOSS, 0.6)
        out.col.push(c.r, c.g, c.b, c.r, c.g, c.b)
      }
      for (let i = 0; i < seg; i++) {
        const a0 = b0 + i * 2
        if (side > 0) out.index.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3)
        else out.index.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2)
      }
    }
  }
}

/** Ветвь у пролога: изогнутая труба от ствола к концу. */
function branchGeometry(plan: ForestPlan, out: { pos: number[]; nor: number[]; col: number[]; index: number[] }): void {
  const [ax, ay, az] = plan.branch.from
  const [bx, by, bz] = plan.branch.to
  const seg = 10
  const radial = 8
  const base = out.pos.length / 3
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az).normalize()
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize()
  const up = new THREE.Vector3().crossVectors(side, dir).normalize()
  const c = BARK_MOSS
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    const sag = Math.sin(Math.PI * t) * 0.6
    const cx = ax + (bx - ax) * t
    const cy = ay + (by - ay) * t - sag
    const cz = az + (bz - az) * t
    const rad = plan.branch.radius * (1 - 0.7 * t)
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2
      const n = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a))
      out.pos.push(cx + n.x * rad, cy + n.y * rad, cz + n.z * rad)
      out.nor.push(n.x, n.y, n.z)
      out.col.push(c.r, c.g, c.b)
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * (radial + 1) + j
      const b2 = a + radial + 1
      out.index.push(a, a + 1, b2, a + 1, b2 + 1, b2)
    }
  }
}

export type Forest = {
  group: THREE.Group
  /** Сколько листвы рисовать: 1 - вся, 0.5 - половина (телефон). */
  setDensity(k: number): void
}

/** Разноцветье: оттенок на экземпляр, чтобы лес не был одной заливкой. */
function tints(seed: number, base: number, spread: number): (i: number) => THREE.Color {
  const r = rng(seed)
  const c = new THREE.Color(base)
  return () => {
    const k = 1 - spread / 2 + r() * spread
    return new THREE.Color(c.r * k * (0.9 + r() * 0.2), c.g * k, c.b * k * (0.85 + r() * 0.3))
  }
}

export function buildForest(plan: ForestPlan): Forest {
  const group = new THREE.Group()
  group.name = 'forest'
  const atlas = leafAtlas()

  // Стволы и ветвь: один слитый меш.
  const acc = { pos: [] as number[], nor: [] as number[], col: [] as number[], index: [] as number[] }
  for (const t of plan.trunks) trunkGeometry(t, acc)
  branchGeometry(plan, acc)
  const tg = new THREE.BufferGeometry()
  tg.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3))
  tg.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nor, 3))
  tg.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3))
  tg.setIndex(acc.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(acc.index, 1) : new THREE.Uint16BufferAttribute(acc.index, 1))
  tg.computeBoundingSphere()
  const trunks = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ vertexColors: true }))
  trunks.name = 'trunks'
  group.add(trunks)

  const leafMat = foliageMaterial(atlas, 0.06)
  const hangMat = foliageMaterial(atlas, 0.12)
  const crownMat = foliageMaterial(atlas, 0.0)

  const meshes: THREE.InstancedMesh[] = []
  const byKind = (k: Plant['kind']) => plan.plants.filter((p) => p.kind === k)
  const add = (m: THREE.InstancedMesh) => {
    meshes.push(m)
    group.add(m)
  }
  add(instanced(plantGeometry('broad', 11), leafMat, byKind('broad'), tints(1, 0x5b8a4a, 0.5), 'plants-broad'))
  add(instanced(plantGeometry('split', 12), leafMat, byKind('split'), tints(2, 0x4f7d44, 0.4), 'plants-split'))
  add(instanced(plantGeometry('fern', 13), leafMat, byKind('fern'), tints(3, 0x5f8a4e, 0.5), 'plants-fern'))
  add(instanced(plantGeometry('grass', 14), leafMat, byKind('grass'), tints(4, 0x6e8f52, 0.5), 'plants-grass'))

  // Кроны пальм - на вершинах их стволов, по наклону оси.
  const palms = plan.trunks
    .filter((t) => t.kind === 'palm')
    .map((t, i) => ({ x: t.x + t.leanX, y: t.y + t.height, z: t.z + t.leanZ, scale: 0.85 + (i % 3) * 0.12, yaw: i * 1.7 }))
  add(instanced(plantGeometry('palm', 15), leafMat, palms, tints(5, 0x587f45, 0.35), 'palm-crowns'))

  // Кроны деревьев: две скрещённые карточки на клок.
  const cb = new Builder()
  cb.card('crown', 1, 1, 0)
  cb.card('crown', 1, 1, Math.PI / 2)
  const crownGeo = cb.geometry()
  crownGeo.translate(0, -0.5, 0)
  add(
    instanced(
      crownGeo,
      crownMat,
      plan.crowns.map((c) => ({ x: c.x, y: c.y, z: c.z, scale: c.size, yaw: c.yaw })),
      tints(6, 0x3f5f36, 0.4),
      'crowns',
    ),
  )

  // Лианы и бороды мха: свисающая лента единичной длины, длина - масштабом по Y.
  for (const kind of ['vine', 'moss'] as const) {
    const hb = new Builder()
    hb.card(kind, kind === 'vine' ? 0.32 : 0.85, 1, 0, true, 0.08)
    hb.card(kind, kind === 'vine' ? 0.32 : 0.85, 1, Math.PI / 2, true, -0.06)
    const items = plan.hangs
      .filter((h) => h.kind === kind)
      .map((h) => ({ x: h.x, y: h.y, z: h.z, scale: 1, sy: h.length, yaw: h.yaw }))
    add(instanced(hb.geometry(), hangMat, items, tints(kind === 'vine' ? 7 : 8, kind === 'vine' ? 0x4d7440 : 0x6a7a4c, 0.35), `hang-${kind}`))
  }

  const full = meshes.map((m) => m.count)
  return {
    group,
    setDensity(k) {
      meshes.forEach((m, i) => {
        m.count = Math.max(1, Math.round(full[i] * Math.min(1, Math.max(0.1, k))))
      })
    },
  }
}
