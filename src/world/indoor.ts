/**
 * world/indoor.ts — свет нутра в шейдерах: чей это воздух, небо внутри,
 * заполняющий свет комнат, затенение углов и зелёный свет из двери.
 *
 * Простая идея. Живых источников в кадре четыре (look.md, «Свет»): лампа
 * входа, фонарь и два точечных, которые менеджер (`lights.ts`) отдаёт
 * светильникам комнаты игрока и соседней. Теней у точечных нет, поэтому свет
 * трубки прошёл бы сквозь перегородку в чужую комнату. Этого не происходит:
 * каждый фрагмент знает, в чьём он воздухе (`vgRoomOf` - по числам раскладки,
 * без текстур), и точечный источник светит только своей комнате, лампа входа -
 * только улице. Точечные при этом - не источники three, а свой цикл в шейдере
 * нутра: у источника three его код получила бы каждая программа мира, а
 * уличные программы - критический путь входа.
 *
 * Всё, что не живое, - формулой в шейдере:
 *   - небо внутри почти не светит (3 %, у открытой двери тамбура больше);
 *   - светильники комнаты, у которых нет живого источника, светят заполняющим
 *     светом без теней (вместо света, запечённого в вершины: у стен ангара
 *     вершины только по углам плит, и перепад по стене в них не уложить);
 *   - затенение углов - по расстоянию до пола, стен и потолка своей комнаты
 *     (SSAO нет, look.md, «Пост-обработка»);
 *   - зелёный прямоугольник из двери на полу и стене тамбура - подделка
 *     проекцией (look.md, «Нутро», тамбур): луч от лампы через окошко или
 *     открытый проём, а не источник.
 *
 * Куски шейдера three правятся один раз, до первой компиляции, как низовой
 * туман в atmosphere.ts; работают они только в материалах, которым отданы
 * юниформы (`indoor(mat)`) - у прочих определения нет, и код выключен.
 */

import * as THREE from 'three'
import { DOOR, ENTRY_LAMP, BLOCK_WALLS, FLOOR, OPENINGS, DOORWAY, HANGAR } from './layout'
import { FIXTURES, PORTALS, ROOMS, ROOM_IDS, type RoomId } from './zones'

/** Индекс комнаты в шейдере. */
export const ROOM_INDEX: Record<RoomId, number> = Object.fromEntries(ROOM_IDS.map((id, i) => [id, i])) as Record<RoomId, number>

/** Коды маски прожектора: кому светит. Номер комнаты - только ей. */
export const MASK = { all: -2, outside: -1, outsideAndA: -3 } as const

/** Общие юниформы света нутра: одни на все материалы, пишет их `lights.ts`. */
export const INDOOR = {
  /**
   * Два живых источника нутра: точка в координатах камеры, свет (цвет x сила,
   * ноль - выключен), дальность и комната, которой светят. Это не источники
   * three, а свой цикл в шейдере: число источников three у всех программ то
   * же, что на поляне, и уличные программы не тяжелеют ни на строку.
   */
  vgLivePos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
  vgLiveCol: { value: [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)] },
  vgLiveRange: { value: [8, 8] as number[] },
  vgLiveRoom: { value: [-9, -9] as number[] },
  /** Заполняющий свет каждого светильника: цвет x сила x доля, линейный. */
  vgFill: { value: FIXTURES.map(() => new THREE.Color(0, 0, 0)) },
  /** Входная дверь: доля открытия и угол створки, рад. */
  vgEntryOpen: { value: 0 },
  vgEntryAngle: { value: 0 },
  /** Кому светит каждый прожектор, в порядке three (с тенью - первым). */
  vgSpotMask: { value: [MASK.outside, MASK.all] as number[] },
  /** Лампа входа для подделки: точка и свет (цвет x сила, ноль - погашена). */
  vgLampPos: { value: new THREE.Vector3((ENTRY_LAMP.x0 + ENTRY_LAMP.x1) / 2, ENTRY_LAMP.y - 0.04, ENTRY_LAMP.z + 0.05) },
  vgLampCol: { value: new THREE.Color(0, 0, 0) },
}

/** Плоскость створки входной двери (закрытой) и внутренней двери тамбура. */
const DOOR_PLANE = -0.255
const INNER_PLANE = (BLOCK_WALLS.AB.z0 + BLOCK_WALLS.AB.z1) / 2
/** Окошко двери и створка: из post.ts / doors.ts, числа раскладки. */
const WIN = {
  x0: (DOOR.x0 + DOOR.x1) / 2 - DOOR.window.w / 2,
  x1: (DOOR.x0 + DOOR.x1) / 2 + DOOR.window.w / 2,
  y0: DOOR.window.y0,
  y1: DOOR.window.y1,
}
const LEAF = { hinge: DOOR.x0 + 0.05, w: DOOR.x1 - DOOR.x0 - 0.1 }

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${+v.toFixed(5)}`)

/** Свод ангара изнутри: те же числа, что `vaultY` в zones.ts. */
const VAULT = {
  z: (HANGAR.z0 + HANGAR.z1) / 2,
  a: (HANGAR.z1 - HANGAR.z0) / 2 - HANGAR.wallThick,
  b: HANGAR.ridge - HANGAR.wall - HANGAR.vaultThick,
  w: HANGAR.wall,
}

function roomGlsl(): string {
  const e = 0.002
  const lines: string[] = []
  ROOM_IDS.forEach((id, i) => {
    const r = ROOMS[id]
    const ceil = r.ceiling === 'vault' ? 'vgVault(q.z)' : f(r.ceiling)
    lines.push(
      `  if (q.x > ${f(r.x0 - e)} && q.x < ${f(r.x1 + e)} && q.z > ${f(r.z0 - e)} && q.z < ${f(r.z1 + e)} && q.y > ${f(r.floor - 0.2)} && q.y < ${ceil} + ${f(e)}) return ${f(i)};`,
    )
  })
  // Толща проёмов между комнатами - комнате по стороне a; входная дверь - улица.
  for (const p of PORTALS) {
    if (p.a === 'out' || p.b === 'out') continue
    const i = ROOM_INDEX[p.a as RoomId]
    lines.push(
      `  if (q.x > ${f(p.x0 - e)} && q.x < ${f(p.x1 + e)} && q.z > ${f(p.z0 - e)} && q.z < ${f(p.z1 + e)} && q.y > ${f(p.y0 - 0.2)} && q.y < ${f(p.y1 + e)}) return ${f(i)};`,
    )
  }
  const boxes = ROOM_IDS.map((id, i) => {
    const r = ROOMS[id]
    return `  if (r < ${f(i + 0.5)}) return vec4(${f(r.x0)}, ${f(r.x1)}, ${f(r.z0)}, ${f(r.z1)});`
  })
  const ys = ROOM_IDS.map((id, i) => {
    const r = ROOMS[id]
    const ceil = r.ceiling === 'vault' ? 'vgVault(z)' : f(r.ceiling)
    return `  if (r < ${f(i + 0.5)}) return vec2(${f(r.floor)}, ${ceil});`
  })
  // Заполняющий свет: светильники своей комнаты.
  const fill: string[] = []
  FIXTURES.forEach((fx, i) => {
    fill.push(`  if (abs(r - ${f(ROOM_INDEX[fx.room])}) < 0.5) c += vgPoint(p, n, vec3(${f(fx.x)}, ${f(fx.y)}, ${f(fx.z)}), vgFill[${i}], ${f(fx.distance)});`)
  })
  return /* glsl */ `
  float vgVault(float z) {
    float u = min(1.0, abs(z - ${f(VAULT.z)}) / ${f(VAULT.a)});
    return ${f(VAULT.w)} + ${f(VAULT.b)} * sqrt(1.0 - u * u);
  }
  float vgRoomOf(vec3 q) {
${lines.join('\n')}
    return -1.0;
  }
  vec4 vgBoxOf(float r) {
${boxes.join('\n')}
    return vec4(0.0);
  }
  vec2 vgYOf(float r, float z) {
${ys.join('\n')}
    return vec2(0.0);
  }
  vec3 vgPoint(vec3 p, vec3 n, vec3 L, vec3 col, float range) {
    vec3 d = L - p;
    float r2 = max(dot(d, d), 0.09);
    vec3 l = d * inversesqrt(r2);
    // Заполняющий свет обходит угол: часть доходит и до граней, отвёрнутых от лампы.
    float ndl = max(dot(n, l), 0.0) * 0.75 + 0.25;
    float fall = r2 / (range * range);
    float win = clamp(1.0 - fall * fall, 0.0, 1.0);
    return col * ndl * win * win / r2;
  }
  vec3 vgFillOf(float r, vec3 p, vec3 n) {
    vec3 c = vec3(0.0);
${fill.join('\n')}
    return c;
  }
`
}

/** Общие функции нутра: объявляются в каждом материале с `VIGIL_INDOOR`. */
const PARS = /* glsl */ `
#ifdef VIGIL_INDOOR
  uniform vec3 vgFill[${FIXTURES.length}];
  uniform float vgEntryOpen;
  uniform float vgEntryAngle;
  uniform float vgSpotMask[2];
  uniform vec3 vgLivePos[2];
  uniform vec3 vgLiveCol[2];
  uniform float vgLiveRange[2];
  uniform float vgLiveRoom[2];
  uniform vec3 vgLampPos;
  uniform vec3 vgLampCol;
  ${roomGlsl()}
  float vgAccept(float mask, float room) {
    if (mask < -2.5) return (room < -0.5 || abs(room) < 0.5) ? 1.0 : 0.0;
    if (mask < -1.5) return 1.0;
    if (mask < -0.5) return room < -0.5 ? 1.0 : 0.0;
    return abs(room - mask) < 0.5 ? 1.0 : 0.0;
  }
  float vgE(float d) { return 1.0 - smoothstep(0.0, 0.45, d); }
  /** Затенение углов по коробке своей комнаты. */
  float vgAO(float r, vec3 p) {
    vec4 b = vgBoxOf(r);
    vec2 y = vgYOf(r, p.z);
    float dx = min(p.x - b.x, b.y - p.x);
    float dz = min(p.z - b.z, b.w - p.z);
    float dw = min(dx, dz);
    float df = p.y - y.x;
    float dc = y.y - p.y;
    float ao = 1.0 - 0.42 * vgE(df) * vgE(dw) - 0.3 * vgE(dx) * vgE(dz) - 0.22 * vgE(dc) * vgE(dw);
    return clamp(ao, 0.35, 1.0);
  }
  float vgRect(vec2 q, vec4 r, float soft) {
    vec2 a = smoothstep(r.xz - soft, r.xz + soft, q);
    vec2 b = 1.0 - smoothstep(r.yw - soft, r.yw + soft, q);
    return a.x * a.y * b.x * b.y;
  }
  /**
   * Зелёный свет лампы входа внутри тамбура и коридора: луч от лампы до
   * точки проходит через окошко закрытой двери или через ту часть проёма,
   * которую не закрыла открытая створка; в коридор - ещё и через проём
   * внутренней двери.
   */
  vec3 vgEntryFake(float r, vec3 p, vec3 n) {
    bool inA = abs(r - ${f(ROOM_INDEX.A)}) < 0.5;
    bool inB = abs(r - ${f(ROOM_INDEX.B)}) < 0.5;
    if (!(inA || inB)) return vec3(0.0);
    vec3 d = p - vgLampPos;
    if (d.z > -0.05) return vec3(0.0);
    float t = (${f(DOOR_PLANE)} - vgLampPos.z) / d.z;
    vec2 q = (vgLampPos + d * t).xy;
    float closed = 1.0 - smoothstep(0.03, 0.18, vgEntryAngle);
    float win = vgRect(q, vec4(${f(WIN.x0)}, ${f(WIN.x1)}, ${f(WIN.y0)}, ${f(WIN.y1)}), 0.012) * closed;
    float edge = ${f(LEAF.hinge)} + ${f(LEAF.w)} * cos(vgEntryAngle);
    float open = vgRect(q, vec4(max(${f(DOOR.x0)}, edge), ${f(DOOR.x1)}, ${f(DOOR.y0)}, ${f(DOOR.y1)}), 0.02) * (1.0 - closed);
    float lit = max(win, open);
    if (inB) {
      float t2 = (${f(INNER_PLANE)} - vgLampPos.z) / d.z;
      vec2 q2 = (vgLampPos + d * t2).xy;
      lit *= vgRect(q2, vec4(${f(OPENINGS.inner.x0 + 0.05)}, ${f(OPENINGS.inner.x1 - 0.05)}, ${f(FLOOR.y)}, ${f(FLOOR.y + DOORWAY.h - 0.05)}), 0.02);
    }
    if (lit <= 0.0) return vec3(0.0);
    float r2 = dot(d, d);
    float ndl = max(dot(n, -d * inversesqrt(r2)), 0.0);
    float fall = r2 / 144.0;
    float win2 = clamp(1.0 - fall * fall, 0.0, 1.0);
    return vgLampCol * lit * ndl * win2 * win2 / r2;
  }
  /** Непрямой свет внутри: небо почти не светит, светильники - заполняющим, углы темнее. */
  vec3 vgIndirect(vec3 irr, float r, vec3 p, vec3 n) {
    if (r < -0.5) return irr;
    float sky = 0.03;
    if (abs(r - ${f(ROOM_INDEX.A)}) < 0.5) sky += 0.3 * vgEntryOpen * exp(-length(p - vec3(${f((DOOR.x0 + DOOR.x1) / 2)}, 1.2, ${f(DOOR_PLANE)})) * 0.8);
    return (irr * sky + vgFillOf(r, p, n)) * vgAO(r, p);
  }
#endif
`

let installed = false

/**
 * Поправить общие куски шейдера three. Один раз, до первой компиляции:
 * поздняя правка не попала бы в уже собранные программы.
 */
export function installIndoorChunks(): void {
  if (installed) return
  installed = true
  THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin + PARS

  // Прожекторы и точечные: маска по комнатам перед вкладом каждого.
  const begin = THREE.ShaderChunk.lights_fragment_begin
  const RE = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );'
  const head = /* glsl */ `
#ifdef VIGIL_INDOOR
  vec3 vgN = inverseTransformDirection( geometryNormal, viewMatrix );
  float vgRoom = vgRoomOf( vFogWorld + vgN * 0.03 );
#endif
`
  const cut = (text: string, marker: string): [string, string] => {
    const i = text.indexOf(marker)
    if (i < 0) throw new Error(`indoor: в lights_fragment_begin нет «${marker}»`)
    return [text.slice(0, i), text.slice(i)]
  }
  const [pre, fromPoint] = cut(begin, '#if ( NUM_POINT_LIGHTS > 0 )')
  const [pointPart, fromSpot] = cut(fromPoint, '#if ( NUM_SPOT_LIGHTS > 0 )')
  const [spotPart, rest] = cut(fromSpot, '#if ( NUM_DIR_LIGHTS > 0 )')
  const maskSpot = /* glsl */ `
		#ifdef VIGIL_INDOOR
		directLight.color *= vgAccept( vgSpotMask[ UNROLLED_LOOP_INDEX ], vgRoom );
		#endif
		${RE}`
  // Живые источники нутра: свой цикл после прожекторов, каждый - только своей комнате.
  const live = /* glsl */ `
#if defined( VIGIL_INDOOR ) && defined( RE_Direct )
	for ( int i = 0; i < 2; i ++ ) {
		if ( abs( vgRoom - vgLiveRoom[ i ] ) > 0.5 ) continue;
		vec3 lv = vgLivePos[ i ] - geometryPosition;
		float ld = length( lv );
		directLight.direction = lv / max( ld, 1e-4 );
		directLight.color = vgLiveCol[ i ] * getDistanceAttenuation( ld, vgLiveRange[ i ], 2.0 );
		directLight.visible = true;
		${RE}
	}
#endif
`
  if (!spotPart.includes(RE)) throw new Error('indoor: в lights_fragment_begin нет вызова RE_Direct')
  THREE.ShaderChunk.lights_fragment_begin = pre + head + pointPart + spotPart.replace(RE, maskSpot) + live + rest

  const end = THREE.ShaderChunk.lights_fragment_end
  const IND = 'RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );'
  if (!end.includes(IND)) throw new Error('indoor: в lights_fragment_end нет RE_IndirectDiffuse')
  THREE.ShaderChunk.lights_fragment_end = end.replace(
    IND,
    /* glsl */ `
	#ifdef VIGIL_INDOOR
	irradiance = vgIndirect( irradiance, vgRoom, vFogWorld, vgN );
	reflectedLight.directDiffuse += vgEntryFake( vgRoom, vFogWorld, vgN ) * BRDF_Lambert( material.diffuseColor );
	#endif
	${IND}`,
  )
}

/**
 * Отдать материалу свет нутра: поверхности, у которых может быть сторона
 * внутри (пост, нутро, предметы). Уличным материалам его не нужно: живые
 * источники нутра - свой цикл, и улицы он не касается.
 */
export function indoor<M extends THREE.Material>(mat: M): M {
  const kind = 'in'
  const before = mat.onBeforeCompile
  const key = mat.customProgramCacheKey.bind(mat)
  // Определение - на материал сразу, а не в `onBeforeCompile`: у шейдера там
  // тот же объект определений, что у материала, и дописанное в нём попало бы в
  // ключ программы только со второй сборки - первый кадр собрал бы всё заново.
  mat.defines = { ...(mat.defines ?? {}), VIGIL_INDOOR: '' }
  mat.onBeforeCompile = (shader, renderer) => {
    before.call(mat, shader, renderer)
    Object.assign(shader.uniforms, INDOOR)
  }
  mat.customProgramCacheKey = () => `${key()}|vigil-${kind}`
  return mat
}
