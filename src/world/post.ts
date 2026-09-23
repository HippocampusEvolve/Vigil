/**
 * world/post.ts — пост снаружи: ангар со сводом, входной блок, навес,
 * отмостка, дверь, лампа, домофон, выключатель, табличка, водосток, выхлоп,
 * бак воды, мачты микрофонов.
 *
 * Всё кодом из коробок, стен с проёмами и труб (geom.ts), числа - из
 * layout.ts. Куски сливаются по материалам: весь бетон - один меш, весь
 * металл - один, стекло, трубка лампы и огонёк домофона - по одному.
 *
 * Правило стыков одно на весь пост, и его проверяет world-check-kit: куски
 * встречаются гранями, смотрящими в РАЗНЫЕ стороны (стена и навес, ребро и
 * свод), и никогда - двумя гранями в одну сторону в одной плоскости. Поэтому
 * западный фронтон ангара стоит между стенами, а не поверх них, и свод
 * начинается за фронтоном, а не под ним.
 */

import * as THREE from 'three'
import { box, merge, paint, pipe, wall, type Hole } from './geom'
import { concreteMaterial } from './concrete'
import { LAMP } from './shared'
import { heightAt } from './terrain'
import {
  BLOCK,
  CANOPY,
  DOOR,
  ENTRY_LAMP,
  EXHAUST,
  GEOPHONE,
  GUTTER,
  HANGAR,
  HANGAR_WINDOWS,
  INTERCOM,
  LAMP_SWITCH,
  MAST_HEIGHT,
  MASTS,
  MIC_ENTRY,
  MIC_ROOF,
  PLINTH,
  SIGN,
  VAULT_RIBS,
  WATER_TANK,
} from './layout'

/** Именованная деталь: по ней проверки называют, кто стоит в спорной точке. */
export type Part = { name: string; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }

export type Post = {
  /** Всё, что рисуется. */
  group: THREE.Group
  /** Во что упирается тело. */
  solid: THREE.Object3D[]
  /** Реестр деталей для проверок. */
  parts: Part[]
  /** Трубка лампы: её сила меняется, когда лампу гасят. */
  tube: THREE.Mesh
  /** Ореол трубки: ядро не тоньше пикселя и рассеяние в дожде. */
  glow: THREE.Mesh
}

/**
 * Сила свечения трубки. Трубка тоньше пикселя уже с десяти метров, и видно
 * её прежде всего ореолом свечения: сила подобрана по эталону кадра так, чтобы
 * ореол давал яркую верхушку кадра, как на референсе.
 */
export const TUBE_POWER = 12

/** Ореол лампы: сила ядра, ближнего свечения и широкого, и запас карточки, м. */
export const GLOW = { core: 10, halo: 1.5, wide: 1.2, pad: 1.3 } as const

/** Сегменты свода по дуге: на 24 метрах свода меньше - видны грани. */
const VAULT_SEG = 28

/** Краски, линейные. Облезлая серо-зелёная дверь, оцинковка, ржавчина. */
const PAINT = {
  door: 0x6f8a7a,
  frame: 0x3a403c,
  steel: 0x6c716e,
  galvanized: 0x8a8f8c,
  rust: 0x5a3a24,
  rustDark: 0x3b2618,
  shutter: 0x2e2a22,
  enamel: 0x8a1c14,
  box: 0x55605a,
  grille: 0x1f2321,
  rubber: 0x121314,
} as const

/** Эллипс свода: центр по Z, полуоси. */
const SPAN = (HANGAR.z1 - HANGAR.z0) / 2
const RISE = HANGAR.ridge - HANGAR.wall
const VAULT_Z = (HANGAR.z0 + HANGAR.z1) / 2
const INNER_A = SPAN - HANGAR.wallThick
const INNER_B = RISE - HANGAR.vaultThick

/**
 * Профиль в плоскости (Z, Y), выдавленный вдоль X от x0 до x1.
 *
 * Форма строится в координатах (s, y) с s = -Z: выдавливание three идёт по
 * своей оси Z, и поворот на четверть оборота вокруг Y переводит её в X, а
 * s - в -Z. Отражения при этом нет, и грани смотрят наружу.
 */
function extrudeX(points: Array<[number, number]>, x0: number, x1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  points.forEach(([z, y], i) => (i ? shape.lineTo(-z, y) : shape.moveTo(-z, y)))
  const g = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false, curveSegments: 1 })
  g.rotateY(Math.PI / 2)
  g.translate(x0, 0, 0)
  return paint(g, 0xffffff)
}

/** Точки эллипса свода от θ0 до θ1: (z, y). */
function arc(a: number, b: number, from: number, to: number, seg = VAULT_SEG): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i <= seg; i++) {
    const t = from + ((to - from) * i) / seg
    out.push([VAULT_Z + a * Math.cos(t), HANGAR.wall + b * Math.sin(t)])
  }
  return out
}

function v(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z)
}

/**
 * Ореол лампы: карточка вдоль трубки, повёрнутая к камере вокруг оси трубки.
 *
 * Трубка тоньше пикселя уже с пятнадцати метров, и растр теряет её целиком,
 * когда она ложится между центрами строк: лампа в кадре то есть, то нет.
 * Ядро ореола поэтому не уже полутора пикселей, а его сила при расширении
 * падает так, что свет линии сохраняется. Вокруг ядра - мягкое свечение:
 * рассеяние в дожде и тумане, которое на референсе и делает лампу лампой.
 */
function lampGlow(): THREE.Mesh {
  const length = ENTRY_LAMP.x1 - ENTRY_LAMP.x0
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Vector3(ENTRY_LAMP.x0, ENTRY_LAMP.y, ENTRY_LAMP.z) },
      uLength: { value: length },
      uColor: { value: new THREE.Color(0x6cb398) },
      uCore: { value: GLOW.core },
      uHalo: { value: GLOW.halo },
      uWide: { value: GLOW.wide },
      uPower: LAMP.power,
      uRadius: { value: ENTRY_LAMP.radius },
      uFogDensity: { value: 0.036 },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uA;
      uniform float uLength;
      varying vec2 vPos;
      varying float vDist;
      const float PAD = ${GLOW.pad.toFixed(2)};
      void main() {
        vec3 axis = vec3(1.0, 0.0, 0.0);
        vec3 mid = uA + axis * uLength * 0.5;
        vec3 toCam = normalize(cameraPosition - mid);
        vec3 up = normalize(cross(axis, toCam));
        float along = position.x * (uLength + 2.0 * PAD);
        float across = position.y * 2.0 * PAD;
        vec3 p = mid + axis * along + up * across;
        // Координаты в метрах от середины трубки; расстояние до отрезка -
        // во фрагментах: модуль и срез нелинейны и между вершинами врут.
        vPos = vec2(along, across);
        vDist = length(cameraPosition - p);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uCore;
      uniform float uHalo;
      uniform float uWide;
      uniform float uPower;
      uniform float uRadius;
      uniform float uFogDensity;
      uniform float uLength;
      varying vec2 vPos;
      varying float vDist;
      void main() {
        float d = length(vec2(max(abs(vPos.x) - uLength * 0.5, 0.0), vPos.y));
        // Ядро: радиус трубки, но не меньше полутора пикселей; сила по площади.
        float px = fwidth(vPos.y);
        float w = max(uRadius, 1.5 * px);
        float core = uCore * (uRadius / w) * exp(-(d * d) / (w * w));
        float halo = uHalo * exp(-(d * d) / 0.0064);
        float wide = uWide * exp(-d / 0.28);
        // Ядро гаснет в тумане по пути до глаза; ореол и есть свет тумана.
        float fog = exp(-uFogDensity * uFogDensity * vDist * vDist);
        vec3 c = uColor * uPower * (core * fog + halo * (0.4 + 0.6 * fog) + wide);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Карточка разворачивается в шейдере, и какой стороной она придёт к
    // камере, зависит от ракурса: отсекать нечего.
    side: THREE.DoubleSide,
    fog: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'entry-glow'
  mesh.frustumCulled = false
  mesh.renderOrder = 2
  return mesh
}

export function buildPost(): Post {
  const parts: Part[] = []
  const note = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void => {
    parts.push({ name, x0, x1, y0, y1, z0, z1 })
  }
  const concrete: THREE.BufferGeometry[] = []
  const metal: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []
  const t = HANGAR.wallThick

  // --- Ангар -------------------------------------------------------------------
  const windows: Hole[] = HANGAR_WINDOWS.xs.map((x) => ({
    u0: x - HANGAR_WINDOWS.w / 2,
    u1: x + HANGAR_WINDOWS.w / 2,
    v0: HANGAR_WINDOWS.sill,
    v1: HANGAR_WINDOWS.sill + HANGAR_WINDOWS.h,
  }))
  concrete.push(paint(wall('z', HANGAR.z1, t, HANGAR.x0, HANGAR.x1, 0, HANGAR.wall, windows), 0xffffff))
  note('ангар: фасад', HANGAR.x0, HANGAR.x1, 0, HANGAR.wall, HANGAR.z1 - t, HANGAR.z1)
  concrete.push(paint(box(HANGAR.x0, HANGAR.x1, 0, HANGAR.wall, HANGAR.z0, HANGAR.z0 + t), 0xffffff))
  note('ангар: задняя стена', HANGAR.x0, HANGAR.x1, 0, HANGAR.wall, HANGAR.z0, HANGAR.z0 + t)
  concrete.push(paint(box(HANGAR.x0, HANGAR.x0 + t, 0, HANGAR.wall, HANGAR.z0 + t, HANGAR.z1 - t), 0xffffff))
  note('ангар: торец', HANGAR.x0, HANGAR.x0 + t, 0, HANGAR.wall, HANGAR.z0 + t, HANGAR.z1 - t)

  // Свод - оболочка между внешним и внутренним эллипсом. Фронтоны закрывают
  // её с торцов целиком: западный на своём месте, восточный - над крышей блока.
  const shell = [...arc(SPAN, RISE, 0, Math.PI), ...arc(INNER_A, INNER_B, Math.PI, 0)]
  concrete.push(extrudeX(shell, HANGAR.x0 + t, HANGAR.x1 - t))
  note('ангар: свод', HANGAR.x0 + t, HANGAR.x1 - t, HANGAR.wall, HANGAR.ridge, HANGAR.z0, HANGAR.z1)
  const gable = arc(SPAN, RISE, 0, Math.PI)
  concrete.push(extrudeX(gable, HANGAR.x0, HANGAR.x0 + t))
  note('ангар: западный фронтон', HANGAR.x0, HANGAR.x0 + t, HANGAR.wall, HANGAR.ridge, HANGAR.z0, HANGAR.z1)
  concrete.push(extrudeX(gable, HANGAR.x1 - t, HANGAR.x1))
  note('ангар: восточный фронтон', HANGAR.x1 - t, HANGAR.x1, HANGAR.wall, HANGAR.ridge, HANGAR.z0, HANGAR.z1)

  // Рёбра свода: пояс поверх оболочки и короткие лопатки на стенах под ним.
  // Внутренняя грань пояса лежит на своде, но смотрит в него, а не наружу.
  const CORBEL = 0.2
  const p = VAULT_RIBS.proud
  for (let i = 0; i < VAULT_RIBS.count; i++) {
    const x = HANGAR.x1 - 1 - i * VAULT_RIBS.step
    const x0 = x - VAULT_RIBS.width / 2
    const x1 = x + VAULT_RIBS.width / 2
    const rib: Array<[number, number]> = [
      [HANGAR.z1 + p, HANGAR.wall - CORBEL],
      ...arc(SPAN + p, RISE + p, 0, Math.PI),
      [HANGAR.z0 - p, HANGAR.wall - CORBEL],
      [HANGAR.z0, HANGAR.wall - CORBEL],
      ...arc(SPAN, RISE, Math.PI, 0),
      [HANGAR.z1, HANGAR.wall - CORBEL],
    ]
    concrete.push(extrudeX(rib, x0, x1))
    note(`ангар: ребро ${i + 1}`, x0, x1, HANGAR.wall - CORBEL, HANGAR.ridge + p, HANGAR.z0 - p, HANGAR.z1 + p)
  }

  // Окна: отлив снаружи, стальная рама в проёме, грязное стекло, за ним ставни
  // из шести досок с пятью узкими щелями.
  const FRAME = 0.04
  const GLASS_Z = HANGAR.z1 - 0.12
  for (const h of windows) {
    const cx = (h.u0 + h.u1) / 2
    concrete.push(paint(box(h.u0 - 0.06, h.u1 + 0.06, h.v0 - 0.06, h.v0, HANGAR.z1, HANGAR.z1 + 0.06), 0xffffff))
    const fz0 = GLASS_Z - 0.03
    const fz1 = GLASS_Z + 0.02
    metal.push(
      paint(box(h.u0, h.u0 + FRAME, h.v0, h.v1, fz0, fz1), PAINT.frame),
      paint(box(h.u1 - FRAME, h.u1, h.v0, h.v1, fz0, fz1), PAINT.frame),
      paint(box(h.u0 + FRAME, h.u1 - FRAME, h.v0, h.v0 + FRAME, fz0, fz1), PAINT.frame),
      paint(box(h.u0 + FRAME, h.u1 - FRAME, h.v1 - FRAME, h.v1, fz0, fz1), PAINT.frame),
      paint(box(cx - 0.015, cx + 0.015, h.v0 + FRAME, h.v1 - FRAME, fz0, fz1 - 0.01), PAINT.frame),
    )
    const pane = new THREE.PlaneGeometry(h.u1 - h.u0 - 2 * FRAME, h.v1 - h.v0 - 2 * FRAME)
    pane.translate(cx, (h.v0 + h.v1) / 2, GLASS_Z)
    glass.push(paint(pane, 0xffffff))
    const boards = 6
    const gap = 0.012
    const bw = (h.u1 - h.u0 - (boards - 1) * gap) / boards
    for (let b = 0; b < boards; b++) {
      const bx = h.u0 + b * (bw + gap)
      metal.push(paint(box(bx, bx + bw, h.v0, h.v1, HANGAR.z1 - t, HANGAR.z1 - t + 0.025), PAINT.shutter))
    }
    note(`окно ${cx}`, h.u0 - 0.06, h.u1 + 0.06, h.v0 - 0.06, h.v1, HANGAR.z1 - t, HANGAR.z1 + 0.06)
  }

  // --- Входной блок ------------------------------------------------------------
  const top = BLOCK.height + BLOCK.parapet
  const w = BLOCK.wall
  const doorHole: Hole = { u0: DOOR.x0, u1: DOOR.x1, v0: DOOR.y0, v1: DOOR.y1 }
  concrete.push(paint(wall('z', BLOCK.z1, w, BLOCK.x0, BLOCK.x1, 0, top, [doorHole]), 0xffffff))
  note('блок: фасад', BLOCK.x0, BLOCK.x1, 0, top, BLOCK.z1 - w, BLOCK.z1)
  concrete.push(paint(box(BLOCK.x0, BLOCK.x1, 0, top, BLOCK.z0, BLOCK.z0 + w), 0xffffff))
  note('блок: задняя стена', BLOCK.x0, BLOCK.x1, 0, top, BLOCK.z0, BLOCK.z0 + w)
  concrete.push(paint(box(BLOCK.x0, BLOCK.x0 + w, 0, top, BLOCK.z0 + w, BLOCK.z1 - w), 0xffffff))
  note('блок: западная стена', BLOCK.x0, BLOCK.x0 + w, 0, top, BLOCK.z0 + w, BLOCK.z1 - w)
  concrete.push(paint(box(BLOCK.x1 - w, BLOCK.x1, 0, top, BLOCK.z0 + w, BLOCK.z1 - w), 0xffffff))
  note('блок: восточная стена', BLOCK.x1 - w, BLOCK.x1, 0, top, BLOCK.z0 + w, BLOCK.z1 - w)
  concrete.push(paint(box(BLOCK.x0 + w, BLOCK.x1 - w, BLOCK.height - 0.3, BLOCK.height, BLOCK.z0 + w, BLOCK.z1 - w), 0xffffff))
  note('блок: крыша', BLOCK.x0 + w, BLOCK.x1 - w, BLOCK.height - 0.3, BLOCK.height, BLOCK.z0 + w, BLOCK.z1 - w)

  // Навес - консоль без опор; отмостка - одна ступень.
  concrete.push(paint(box(CANOPY.x0, CANOPY.x1, CANOPY.y, CANOPY.y + CANOPY.thick, CANOPY.z0, CANOPY.z1), 0xffffff))
  note('навес', CANOPY.x0, CANOPY.x1, CANOPY.y, CANOPY.y + CANOPY.thick, CANOPY.z0, CANOPY.z1)
  concrete.push(paint(box(PLINTH.x0, PLINTH.x1, 0, PLINTH.top, PLINTH.z0, PLINTH.z1), 0xffffff))
  note('отмостка', PLINTH.x0, PLINTH.x1, 0, PLINTH.top, PLINTH.z0, PLINTH.z1)

  // --- Дверь -------------------------------------------------------------------
  // Коробка в глубине проёма, полотно утоплено в неё на сантиметр.
  const dz0 = BLOCK.z1 - DOOR.recess
  const dz1 = dz0 + 0.08
  const F = 0.05
  metal.push(
    paint(box(DOOR.x0, DOOR.x0 + F, DOOR.y0, DOOR.y1, dz0, dz1), PAINT.frame),
    paint(box(DOOR.x1 - F, DOOR.x1, DOOR.y0, DOOR.y1, dz0, dz1), PAINT.frame),
    paint(box(DOOR.x0 + F, DOOR.x1 - F, DOOR.y1 - F, DOOR.y1, dz0, dz1), PAINT.frame),
  )
  const leafFace = dz1 - 0.01
  const win = DOOR.window
  const winX = (DOOR.x0 + DOOR.x1) / 2
  const leaf = wall('z', leafFace, 0.05, DOOR.x0 + F, DOOR.x1 - F, DOOR.y0, DOOR.y1 - F, [
    { u0: winX - win.w / 2, u1: winX + win.w / 2, v0: win.y0, v1: win.y1 },
  ])
  metal.push(paint(leaf, PAINT.door))
  const doorPane = new THREE.PlaneGeometry(win.w, win.y1 - win.y0)
  doorPane.translate(winX, (win.y0 + win.y1) / 2, leafFace - 0.025)
  glass.push(paint(doorPane, 0xffffff))
  metal.push(paint(box(DOOR.x1 - F - 0.14, DOOR.x1 - F - 0.1, 1.0, 1.1, leafFace, leafFace + 0.06), PAINT.steel))
  note('дверь', DOOR.x0, DOOR.x1, DOOR.y0, DOOR.y1, dz0, dz1)

  // --- Лампа входа --------------------------------------------------------------
  // Жёлоб на стене, трубка перед ним, решётка скобами.
  const lx0 = ENTRY_LAMP.x0 - 0.03
  const lx1 = ENTRY_LAMP.x1 + 0.03
  metal.push(paint(box(lx0, lx1, ENTRY_LAMP.y - 0.06, ENTRY_LAMP.y + 0.06, BLOCK.z1, BLOCK.z1 + 0.09), PAINT.steel))
  metal.push(
    paint(box(ENTRY_LAMP.x0 - 0.03, ENTRY_LAMP.x0, ENTRY_LAMP.y - 0.03, ENTRY_LAMP.y + 0.03, BLOCK.z1 + 0.09, ENTRY_LAMP.z + 0.02), PAINT.box),
    paint(box(ENTRY_LAMP.x1, ENTRY_LAMP.x1 + 0.03, ENTRY_LAMP.y - 0.03, ENTRY_LAMP.y + 0.03, BLOCK.z1 + 0.09, ENTRY_LAMP.z + 0.02), PAINT.box),
  )
  for (let i = 0; i < 6; i++) {
    const x = ENTRY_LAMP.x0 + 0.08 + (i * (ENTRY_LAMP.x1 - ENTRY_LAMP.x0 - 0.16)) / 5
    metal.push(
      paint(box(x - 0.004, x + 0.004, ENTRY_LAMP.y - 0.058, ENTRY_LAMP.y - 0.05, BLOCK.z1 + 0.09, ENTRY_LAMP.z + 0.045), PAINT.grille),
      paint(box(x - 0.004, x + 0.004, ENTRY_LAMP.y - 0.058, ENTRY_LAMP.y + 0.04, ENTRY_LAMP.z + 0.045, ENTRY_LAMP.z + 0.053), PAINT.grille),
    )
  }
  metal.push(paint(box(ENTRY_LAMP.x0, ENTRY_LAMP.x1, ENTRY_LAMP.y - 0.058, ENTRY_LAMP.y - 0.052, ENTRY_LAMP.z + 0.053, ENTRY_LAMP.z + 0.059), PAINT.grille))
  note('лампа входа', lx0, lx1, ENTRY_LAMP.y - 0.06, ENTRY_LAMP.y + 0.06, BLOCK.z1, ENTRY_LAMP.z + 0.06)

  const tubeGeo = new THREE.CylinderGeometry(ENTRY_LAMP.radius, ENTRY_LAMP.radius, ENTRY_LAMP.x1 - ENTRY_LAMP.x0, 12)
  tubeGeo.rotateZ(Math.PI / 2)
  tubeGeo.translate((ENTRY_LAMP.x0 + ENTRY_LAMP.x1) / 2, ENTRY_LAMP.y, ENTRY_LAMP.z)
  // Сила выше единицы: после экспозиции и кривой трубка - самое яркое в
  // кадре, и свечение берёт её, а не отсветы.
  const tubeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x6cb398).multiplyScalar(TUBE_POWER), fog: false })
  const tube = new THREE.Mesh(tubeGeo, tubeMat)
  tube.name = 'entry-tube'
  const glow = lampGlow()

  // --- Домофон, выключатель, табличка ------------------------------------------
  const ix0 = INTERCOM.x - INTERCOM.w / 2
  const ix1 = INTERCOM.x + INTERCOM.w / 2
  const iy0 = INTERCOM.y - INTERCOM.h / 2
  const iy1 = INTERCOM.y + INTERCOM.h / 2
  metal.push(
    paint(box(ix0, ix1, iy0, iy1, BLOCK.z1, BLOCK.z1 + INTERCOM.d), PAINT.box),
    paint(box(ix0 + 0.02, ix1 - 0.02, INTERCOM.y + 0.0, iy1 - 0.02, BLOCK.z1 + INTERCOM.d, BLOCK.z1 + INTERCOM.d + 0.003), PAINT.grille),
  )
  const button = new THREE.CylinderGeometry(0.013, 0.013, 0.008, 12)
  button.rotateX(Math.PI / 2)
  button.translate(INTERCOM.x, iy0 + 0.045, BLOCK.z1 + INTERCOM.d + 0.004)
  metal.push(paint(button, PAINT.steel))
  note('домофон', ix0, ix1, iy0, iy1, BLOCK.z1, BLOCK.z1 + INTERCOM.d + 0.008)
  const ledGeo = new THREE.SphereGeometry(0.004, 8, 6)
  ledGeo.translate(ix1 - 0.022, iy0 + 0.045, BLOCK.z1 + INTERCOM.d + 0.002)

  const sx0 = LAMP_SWITCH.x - LAMP_SWITCH.w / 2
  const sx1 = LAMP_SWITCH.x + LAMP_SWITCH.w / 2
  const sy0 = LAMP_SWITCH.y - LAMP_SWITCH.h / 2
  const sy1 = LAMP_SWITCH.y + LAMP_SWITCH.h / 2
  metal.push(paint(box(sx0, sx1, sy0, sy1, BLOCK.z1, BLOCK.z1 + LAMP_SWITCH.d), PAINT.box))
  metal.push(paint(pipe(v(LAMP_SWITCH.x, LAMP_SWITCH.y, BLOCK.z1 + LAMP_SWITCH.d), v(LAMP_SWITCH.x, LAMP_SWITCH.y + 0.03, BLOCK.z1 + LAMP_SWITCH.d + 0.04), 0.006, 8), PAINT.steel))
  note('выключатель', sx0, sx1, sy0, sy1, BLOCK.z1, BLOCK.z1 + LAMP_SWITCH.d + 0.05)

  // Табличка - на отступе от стены: плоское поверх плоского без зазора - это
  // полосы, а не замысел.
  metal.push(paint(box(SIGN.x0, SIGN.x1, SIGN.y0, SIGN.y1, BLOCK.z1 + 0.004, BLOCK.z1 + 0.009), PAINT.enamel))
  note('табличка', SIGN.x0, SIGN.x1, SIGN.y0, SIGN.y1, BLOCK.z1, BLOCK.z1 + 0.009)

  // --- Водосток, выхлоп ------------------------------------------------------------
  const roofTop = CANOPY.y + CANOPY.thick
  metal.push(paint(pipe(v(GUTTER.x, GUTTER.mouth, GUTTER.z), v(GUTTER.x, roofTop + 0.06, GUTTER.z), GUTTER.radius), PAINT.rust))
  const funnel = new THREE.CylinderGeometry(0.13, GUTTER.radius, 0.12, 12, 1, true)
  funnel.translate(GUTTER.x, roofTop + 0.12, GUTTER.z)
  metal.push(paint(funnel, PAINT.rustDark))
  note('водосток: труба', GUTTER.x - 0.13, GUTTER.x + 0.13, GUTTER.mouth, roofTop + 0.18, GUTTER.z - 0.13, GUTTER.z + 0.13)

  const ex = BLOCK.x1 + 0.012 + EXHAUST.radius
  metal.push(
    paint(pipe(v(BLOCK.x1 - 0.02, EXHAUST.y0, EXHAUST.z), v(ex, EXHAUST.y0, EXHAUST.z), EXHAUST.radius), PAINT.rustDark),
    paint(pipe(v(ex, EXHAUST.y0 - EXHAUST.radius, EXHAUST.z), v(ex, EXHAUST.y1, EXHAUST.z), EXHAUST.radius), PAINT.rust),
  )
  const hat = new THREE.ConeGeometry(0.11, 0.1, 12)
  hat.translate(ex, EXHAUST.y1 + 0.11, EXHAUST.z)
  metal.push(paint(hat, PAINT.rustDark))
  metal.push(paint(pipe(v(ex, EXHAUST.y1 + 0.0, EXHAUST.z), v(ex, EXHAUST.y1 + 0.07, EXHAUST.z), 0.008, 6), PAINT.rustDark))
  for (const y of [2.7, 3.45]) metal.push(paint(box(BLOCK.x1, ex + 0.01, y - 0.015, y + 0.015, EXHAUST.z - 0.01, EXHAUST.z + 0.01), PAINT.rustDark))
  note('выхлоп', BLOCK.x1 - 0.02, ex + EXHAUST.radius, EXHAUST.y0 - EXHAUST.radius, EXHAUST.y1 + 0.16, EXHAUST.z - 0.11, EXHAUST.z + 0.11)

  // --- Бак воды ----------------------------------------------------------------
  const T = WATER_TANK
  const r = T.diameter / 2
  const leg = 0.55
  for (const [dx, dz] of [
    [-leg, -leg],
    [leg, -leg],
    [-leg, leg],
    [leg, leg],
  ]) {
    const x = T.x + dx
    const z = T.z + dz
    // Нога уходит в грязь: так стоит любая стойка на размокшей земле.
    metal.push(paint(box(x - 0.03, x + 0.03, heightAt(x, z) - 0.15, T.stand, z - 0.03, z + 0.03), PAINT.rustDark))
  }
  metal.push(
    paint(box(T.x - leg - 0.03, T.x + leg + 0.03, T.stand - 0.06, T.stand, T.z - leg - 0.03, T.z - leg + 0.03), PAINT.rustDark),
    paint(box(T.x - leg - 0.03, T.x + leg + 0.03, T.stand - 0.06, T.stand, T.z + leg - 0.03, T.z + leg + 0.03), PAINT.rustDark),
    paint(box(T.x - leg - 0.03, T.x - leg + 0.03, T.stand - 0.06, T.stand, T.z - leg + 0.03, T.z + leg - 0.03), PAINT.rustDark),
    paint(box(T.x + leg - 0.03, T.x + leg + 0.03, T.stand - 0.06, T.stand, T.z - leg + 0.03, T.z + leg - 0.03), PAINT.rustDark),
  )
  const drum = new THREE.CylinderGeometry(r, r, T.height, 24, 1, false)
  drum.translate(T.x, T.stand + T.height / 2, T.z)
  metal.push(paint(drum, PAINT.rust))
  const lid = new THREE.ConeGeometry(r + 0.02, 0.16, 24, 1, false)
  lid.translate(T.x, T.stand + T.height + 0.08, T.z)
  metal.push(paint(lid, PAINT.rustDark))
  // Перелив: трубка из бока вниз, с неё капает.
  const oy = T.stand + T.height - 0.15
  metal.push(
    paint(pipe(v(T.x + r - 0.02, oy, T.z + 0.2), v(T.x + r + 0.12, oy, T.z + 0.2), 0.022, 8), PAINT.rustDark),
    paint(pipe(v(T.x + r + 0.12, oy + 0.022, T.z + 0.2), v(T.x + r + 0.12, 0.55, T.z + 0.2), 0.022, 8), PAINT.rustDark),
  )
  note('бак', T.x - r - 0.15, T.x + r + 0.15, 0, T.stand + T.height + 0.16, T.z - r, T.z + r)

  // --- Мачты микрофонов ---------------------------------------------------------
  for (const m of MASTS) {
    const g = heightAt(m.x, m.z)
    metal.push(paint(pipe(v(m.x, g - 0.3, m.z), v(m.x, g + MAST_HEIGHT, m.z), 0.03), PAINT.galvanized))
    const cone = new THREE.ConeGeometry(0.09, 0.1, 14, 1, true)
    cone.translate(m.x, g + MAST_HEIGHT + 0.03, m.z)
    metal.push(paint(cone, PAINT.steel))
    metal.push(paint(pipe(v(m.x, g + MAST_HEIGHT - 0.1, m.z), v(m.x, g + MAST_HEIGHT - 0.02, m.z), 0.02, 10), PAINT.grille))
    metal.push(paint(box(m.x - 0.07, m.x + 0.07, g + 1.0, g + 1.18, m.z + 0.03, m.z + 0.11), PAINT.box))
    metal.push(paint(box(m.x - 0.09, m.x + 0.09, g + 1.5, g + 1.6, m.z + 0.03, m.z + 0.034), PAINT.galvanized))
    note(`мачта ${m.channel}`, m.x - 0.09, m.x + 0.09, g - 0.3, g + MAST_HEIGHT + 0.1, m.z - 0.09, m.z + 0.11)
  }

  // Микрофон входа на кронштейне под навесом и микрофон на гребне свода.
  metal.push(
    paint(pipe(v(MIC_ENTRY.x, MIC_ENTRY.y, BLOCK.z1), v(MIC_ENTRY.x, MIC_ENTRY.y, MIC_ENTRY.z - 0.04), 0.008, 6), PAINT.steel),
    paint(pipe(v(MIC_ENTRY.x, MIC_ENTRY.y, MIC_ENTRY.z - 0.04), v(MIC_ENTRY.x, MIC_ENTRY.y, MIC_ENTRY.z + 0.04), 0.025, 10), PAINT.grille),
  )
  note('микрофон входа', MIC_ENTRY.x - 0.03, MIC_ENTRY.x + 0.03, MIC_ENTRY.y - 0.03, MIC_ENTRY.y + 0.03, BLOCK.z1, MIC_ENTRY.z + 0.04)
  metal.push(
    paint(pipe(v(MIC_ROOF.x, HANGAR.ridge - 0.05, MIC_ROOF.z), v(MIC_ROOF.x, MIC_ROOF.y, MIC_ROOF.z), 0.012, 6), PAINT.steel),
    paint(pipe(v(MIC_ROOF.x, MIC_ROOF.y, MIC_ROOF.z), v(MIC_ROOF.x, MIC_ROOF.y + 0.08, MIC_ROOF.z), 0.025, 10), PAINT.grille),
  )
  note('микрофон крыши', MIC_ROOF.x - 0.03, MIC_ROOF.x + 0.03, HANGAR.ridge - 0.05, MIC_ROOF.y + 0.08, MIC_ROOF.z - 0.03, MIC_ROOF.z + 0.03)
  {
    const g = heightAt(GEOPHONE.x, GEOPHONE.z)
    metal.push(paint(pipe(v(GEOPHONE.x, g - 0.3, GEOPHONE.z), v(GEOPHONE.x, g + 0.3, GEOPHONE.z), 0.015, 8), PAINT.rustDark))
    metal.push(paint(box(GEOPHONE.x - 0.04, GEOPHONE.x + 0.04, g + 0.3, g + 0.38, GEOPHONE.z - 0.04, GEOPHONE.z + 0.04), PAINT.box))
    note('геофон', GEOPHONE.x - 0.04, GEOPHONE.x + 0.04, g - 0.3, g + 0.38, GEOPHONE.z - 0.04, GEOPHONE.z + 0.04)
  }

  // --- Сборка ---------------------------------------------------------------------
  const group = new THREE.Group()
  group.name = 'post'

  const concreteMesh = new THREE.Mesh(merge(concrete), concreteMaterial())
  concreteMesh.name = 'post-concrete'
  concreteMesh.castShadow = true
  concreteMesh.receiveShadow = true

  const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 })
  const metalMesh = new THREE.Mesh(merge(metal), metalMat)
  metalMesh.name = 'post-metal'
  metalMesh.castShadow = true
  metalMesh.receiveShadow = true

  // Стекло грязное и мокрое: тёмное, почти зеркальное, чуть мутное.
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x1a2622,
    roughness: 0.18,
    metalness: 0.0,
    transparent: true,
    opacity: 0.78,
  })
  const glassMesh = new THREE.Mesh(merge(glass), glassMat)
  glassMesh.name = 'post-glass'
  glassMesh.receiveShadow = true

  const led = new THREE.Mesh(ledGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a14).multiplyScalar(3), fog: true }))
  led.name = 'intercom-led'

  group.add(concreteMesh, metalMesh, glassMesh, tube, glow, led)
  return { group, solid: [concreteMesh, metalMesh], parts, tube, glow }
}
