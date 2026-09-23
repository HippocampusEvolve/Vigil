/**
 * world/concrete.ts — выветренный бетон поста: мох, потёки, сырость.
 *
 * Весь бетон поста - один меш и один материал, поэтому всё, что отличает
 * крышу от цоколя, решается по месту в мире, а не картами на каждую деталь:
 *
 *   - мох - по нормали: на горизонталях и на своде сплошной, на вертикалях
 *     пятнами, в нишах у земли гуще;
 *   - потёки - вертикальные тёмные полосы на стенах, гуще под кромками;
 *   - сырость - затемнение и глянец снизу стен до 0.6 м;
 *   - отсвет лампы - поддельный: низ навеса и стена у двери получают
 *     градиент от трубки. Прожектор лампы смотрит вниз-вперёд и потолок над
 *     собой не освещает, а на референсе низ навеса зелёный.
 *
 * Рельеф поверхности - неровность от шума через производные экрана (bump),
 * без карт: у бетона она мелкая, и в тумане её хватает.
 *
 * Изнутри тот же бетон - крашеный (look.md, «Нутро»): у стены и перегородки
 * одна деталь на две стороны, и что на грани, решает шейдер по тому, в чей
 * воздух она смотрит (`vgRoomOf` из indoor.ts):
 *   - стены жилых комнат в две краски: низ до 1.5 м - глянцевая
 *     бирюзово-зелёная масляная, облезает пластами; верх и свод - побелка в
 *     разводах и плесени;
 *   - пол - коричнево-красная половая краска, вытертая до серого тропами между
 *     проёмами;
 *   - нижний ярус - голый мокрый бетон с ржавыми потёками;
 *   - стена зарубок - генератор здесь же, в шейдере: группы по пять царапин
 *     рядами, сверху вниз, с годами строки гуляют (look.md, «Стена зарубок»);
 *   - в молнию на пол у окон ложатся полосы света сквозь щели ставен.
 */

import * as THREE from 'three'
import { LAMP_GLSL, lampUniforms, FLASH } from './shared'
import { indoor, ROOM_INDEX } from './indoor'
import { GENERATOR, HANGAR_WINDOWS, LOWER, NOTCH_WALL } from './layout'
import { PORTALS, ROOM_IDS, portalCenter, type RoomId } from './zones'

/** Общий шум мира на GLSL: хэш и трёхмерный шум значений. */
export const NOISE_GLSL = /* glsl */ `
  float wHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float wNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(wHash(i + vec3(0, 0, 0)), wHash(i + vec3(1, 0, 0)), f.x),
                   mix(wHash(i + vec3(0, 1, 0)), wHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(wHash(i + vec3(0, 0, 1)), wHash(i + vec3(1, 0, 1)), f.x),
                   mix(wHash(i + vec3(0, 1, 1)), wHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float wFbm(vec3 p) {
    return 0.55 * wNoise(p) + 0.3 * wNoise(p * 2.13 + 1.7) + 0.15 * wNoise(p * 4.41 + 3.1);
  }
`

/**
 * Стена зарубок: сколько процарапано и какая обведена. Без слоя данных стена
 * полна - столько, сколько на ней умещается рядов; число суток и обведённая
 * зарубка приходят сюжетным слоем.
 */
export const NOTCHES = {
  count: { value: NOTCH_WALL.rows * NOTCH_WALL.cols * 5 - 400 },
  mark: { value: -1 },
}

const g = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${+v.toFixed(5)}`)

/**
 * Тропы по полу: где ходят, там краска вытерта до серого. Отрезки между
 * проёмами каждой комнаты и к её главному месту - то, чем комната живёт.
 */
function wearSegments(): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = []
  const hub: Partial<Record<RoomId, [number, number]>> = {
    C: [GENERATOR.x - 0.6, GENERATOR.z + 1.0],
    D: [1.6, -6.9],
    E: [-2.8, -3.4],
    F: [-9.5, -1.5],
    G: [-15.0, -6.5],
    H: [-21.0, -5.5],
  }
  for (const id of ROOM_IDS) {
    if (id === 'I' || id === 'J') continue
    const doors = PORTALS.filter((p) => p.a === id || p.b === id).map(portalCenter)
    const pts: Array<[number, number]> = doors.map((c) => [c.x, c.z])
    const h = hub[id]
    if (h) pts.push(h)
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) out.push([pts[i][0], pts[i][1], pts[j][0], pts[j][1]])
  }
  return out
}

function interiorGlsl(): string {
  const segs = wearSegments()
  const segLines = segs.map(([ax, az, bx, bz]) => `    w = max(w, 1.0 - smoothstep(0.22, 0.75, cSeg(p.xz, vec2(${g(ax)}, ${g(az)}), vec2(${g(bx)}, ${g(bz)}))));`)
  const W = NOTCH_WALL
  const pitch = (W.x1 - W.x0) / W.cols
  const rowH = (W.y1 - W.y0) / W.rows
  const wins = HANGAR_WINDOWS.xs.map((x) => `    s = max(s, cSlits(p, ${g(x)}));`)
  return /* glsl */ `
  uniform float uNotchCount;
  uniform float uNotchMark;
  float cSeg(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
    return length(p - a - ab * t);
  }
  /** Сколько краски вытерто ногами: 1 - посреди тропы. */
  float cWear(vec3 p) {
    float w = 0.0;
${segLines.join('\n')}
    return w;
  }
  float cLine(vec2 p, vec2 a, vec2 b, float w, float aa) {
    return 1.0 - smoothstep(w - aa, w + aa, cSeg(p, a, b));
  }
  /**
   * Зарубки: сила царапины и её свежесть (1 - последние сотни). uv - метры
   * от левого верхнего угла стены вправо и вниз.
   */
  vec2 cNotch(vec2 uv, float aa) {
    float row = floor(uv.y / ${g(rowH)});
    if (row < 0.0 || row >= ${g(W.rows)}) return vec2(0.0);
    float age = row / ${g(W.rows)};
    // С годами строки гуляют: шаг ровный в первых рядах, плывёт в последних.
    float drift = (wNoise(vec3(row * 1.73, uv.x * 0.9, 3.1)) - 0.5) * 0.014 * smoothstep(0.12, 0.7, age);
    float col = floor(uv.x / ${g(pitch)});
    float gi = row * ${g(W.cols)} + col;
    float n0 = gi * 5.0;
    if (n0 >= uNotchCount) return vec2(0.0);
    vec2 q = vec2(uv.x - col * ${g(pitch)}, uv.y - row * ${g(rowH)} - drift);
    float h = 0.028 + 0.008 * wHash(vec3(gi, 1.0, 7.0));
    float top = 0.006 + 0.004 * wHash(vec3(gi, 2.0, 3.0));
    float bot = top + h;
    float shaky = 0.3 + 1.7 * age;
    float ink = 0.0;
    float w = 0.0009 + 0.0005 * wHash(vec3(gi, 5.0, 1.0));
    for (int k = 0; k < 4; k++) {
      if (n0 + float(k) >= uNotchCount) break;
      float x = 0.008 + float(k) * 0.0062 + (wHash(vec3(gi, float(k), 9.0)) - 0.5) * 0.0016 * shaky;
      float lean = (wHash(vec3(gi, float(k), 4.0)) - 0.5) * 0.004 * shaky;
      ink = max(ink, cLine(q, vec2(x + lean, top), vec2(x - lean, bot), w, aa));
    }
    if (n0 + 4.0 < uNotchCount) ink = max(ink, cLine(q, vec2(0.003, bot - 0.004), vec2(0.033, top + 0.005), w, aa));
    // Обведённая: кольцо вокруг своей группы.
    if (uNotchMark >= 0.0 && abs(floor(uNotchMark / 5.0) - gi) < 0.5) {
      float ring = abs(length((q - vec2(0.019, (top + bot) * 0.5)) * vec2(1.0, 0.75)) - 0.03);
      ink = max(ink, 1.0 - smoothstep(0.0012 - aa, 0.0012 + aa, ring));
    }
    float pressure = 0.55 + 0.45 * wHash(vec3(gi, 8.0, 2.0));
    float fresh = smoothstep(uNotchCount - 400.0, uNotchCount - 40.0, n0);
    // Издалека штрихи мельче пикселя: сводим к средней плотности, без муара.
    float far = smoothstep(0.0008, 0.004, aa);
    return vec2(mix(ink * pressure, 0.07, far), fresh);
  }
  /** Полосы света сквозь щели ставен на полу у окна при молнии. */
  float cSlits(vec3 p, float cx) {
    float dx = p.x - cx;
    if (abs(dx) > ${g(HANGAR_WINDOWS.w / 2)}) return 0.0;
    // Свет неба падает под 45°: пятно на полу там, куда смотрит окно сверху.
    float along = smoothstep(-0.9, -1.25, p.z) * (1.0 - smoothstep(-1.95, -2.35, p.z));
    float boards = 6.0;
    float bw = ${g(HANGAR_WINDOWS.w)} / boards;
    float u = (dx + ${g(HANGAR_WINDOWS.w / 2)}) / bw;
    float gap = abs(fract(u + 0.5) - 0.5) * bw;
    float line = 1.0 - smoothstep(0.004, 0.018, gap);
    line *= step(0.5, u) * step(u, boards - 0.5);
    return line * along;
  }
  float cSlitsAll(vec3 p) {
    float s = 0.0;
${wins.join('\n')}
    return s;
  }
`
}

/** Альбедо бетона и мха, линейное: середина, темноту даёт туман. */
const CONCRETE = new THREE.Color(0x8a8e85)
const MOSS = new THREE.Color(0x4e6a34)
const MOSS_DARK = new THREE.Color(0x2f4424)

/** Краски нутра, линейные (look.md, «Нутро»): середина, темноту даёт свет. */
const INSIDE = {
  oil: new THREE.Color(0.075, 0.26, 0.205),
  whitewash: new THREE.Color(0.5, 0.51, 0.47),
  plaster: new THREE.Color(0.34, 0.33, 0.3),
  floor: new THREE.Color(0.2, 0.068, 0.042),
  worn: new THREE.Color(0.25, 0.24, 0.22),
  bare: new THREE.Color(0.26, 0.26, 0.24),
  rust: new THREE.Color(0.22, 0.09, 0.035),
  mold: new THREE.Color(0.09, 0.1, 0.07),
}

/**
 * Бетон поста. `inside` - с краской нутра: такой материал собирается второй
 * волной, вместе с нутром; первому кадру хватает уличного, и его программа не
 * несёт ни строки нутра - это критический путь входа.
 */
export function concreteMaterial(inside = false): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: CONCRETE, roughness: 0.9, metalness: 0 })
  mat.onBeforeCompile = (shader) => {
    lampUniforms(shader.uniforms)
    shader.uniforms.uMoss = { value: MOSS }
    shader.uniforms.uMossDark = { value: MOSS_DARK }
    shader.uniforms.uFlash = FLASH
    shader.uniforms.uNotchCount = NOTCHES.count
    shader.uniforms.uNotchMark = NOTCHES.mark
    for (const [k, c] of Object.entries(INSIDE)) shader.uniforms[`uIn_${k}`] = { value: c }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vCWorld;
         varying vec3 vCNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vCWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vCNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vCWorld;
         varying vec3 vCNormal;
         uniform vec3 uMoss;
         uniform vec3 uMossDark;
         uniform float uFlash;
         ${NOISE_GLSL}
         ${LAMP_GLSL}
         ${Object.keys(INSIDE).map((k) => `uniform vec3 uIn_${k};`).join('\n')}
         float cMoss;
         float cDamp;
         float cInside;
         float cRough;
         float cBumpIn;
         float cSlit;
         float cHeight(vec3 p) {
           return wFbm(p * 3.1) * 0.6 + wNoise(p * 11.0) * 0.4;
         }
         #ifdef VIGIL_INDOOR
         ${interiorGlsl()}
         #endif`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         cInside = 0.0;
         cSlit = 0.0;
         cRough = 0.9;
         cBumpIn = 0.006;
         {
           vec3 p = vCWorld;
           vec3 n = normalize(vCNormal);
           #ifdef VIGIL_INDOOR
           float room = vgRoomOf(p + n * 0.03);
           if (room > -0.5) {
             cInside = 1.0;
             bool lower = room > ${g(ROOM_INDEX.H + 0.5)};
             float big = wFbm(p * 0.6);
             float fine = wFbm(p * 3.3);
             float grain = wNoise(p * 23.0);
             vec3 c;
             if (lower) {
               // Низ: голый бетон, мокрый, ржавые потёки от труб, у пола темнее.
               c = uIn_bare * (0.75 + 0.4 * big + 0.1 * (grain - 0.5));
               float streak = smoothstep(0.62, 0.95, wNoise(vec3((abs(n.x) > abs(n.z) ? p.z : p.x) * 9.0, p.y * 0.4, 1.0)));
               c = mix(c, uIn_rust, streak * 0.5 * step(abs(n.y), 0.5));
               float wet = 1.0 - smoothstep(${g(LOWER.floor + 0.05)}, ${g(LOWER.floor + 0.9)}, p.y);
               c *= 1.0 - 0.35 * wet;
               cRough = mix(0.55, 0.22, wet);
               cBumpIn = 0.014;
             } else if (n.y > 0.7) {
               // Пол: половая краска, вытертая тропами до серого; у стен цела.
               float w = cWear(p) * (0.7 + 0.5 * big);
               float patchy = smoothstep(0.35, 0.75, fine + 0.25 * (grain - 0.5));
               c = mix(uIn_floor, uIn_worn, clamp(w * (0.6 + 0.6 * patchy), 0.0, 1.0));
               c *= 0.82 + 0.3 * big;
               cRough = mix(0.5, 0.82, w);
               cBumpIn = 0.004;
               // Масляные пятна вокруг генератора.
               float oil = 1.0 - smoothstep(0.4, 1.6, length(p.xz - vec2(${g(GENERATOR.x)}, ${g(GENERATOR.z)})));
               oil *= smoothstep(0.45, 0.7, wNoise(p * 2.3));
               c = mix(c, c * 0.35, oil);
               cRough = mix(cRough, 0.3, oil);
               cSlit = cSlitsAll(p);
             } else if (n.y < -0.5 || p.y > 2.2) {
               // Потолок и свод: побелка, рыжие разводы от протечек.
               c = uIn_whitewash * (0.86 + 0.2 * big);
               float stain = smoothstep(0.55, 0.8, wFbm(p * 0.9 + 4.0));
               c = mix(c, c * vec3(0.78, 0.66, 0.5), stain * 0.7);
               cRough = 0.93;
               cBumpIn = 0.006;
             } else {
               // Стены: масляная краска до 1.5 м, выше побелка; краска
               // облезает пластами, побелку ест плесень у потолка и в углах.
               float band = step(p.y, 1.5 + 0.004 * (grain - 0.5));
               float line = 1.0 - smoothstep(0.004, 0.009, abs(p.y - 1.5));
               vec3 paintC = uIn_oil * (0.88 + 0.22 * big);
               vec3 lime = uIn_whitewash * (0.85 + 0.2 * big);
               float flake = wFbm(p * 1.9 + 11.0);
               float peel = smoothstep(0.62, 0.66, flake + 0.18 * (1.0 - smoothstep(0.0, 0.5, p.y)));
               float edge = smoothstep(0.58, 0.62, flake) - peel;
               vec3 low = mix(paintC, uIn_plaster, peel) * (1.0 - 0.35 * max(edge, 0.0));
               float mold = smoothstep(0.55, 0.8, wFbm(p * 1.3 + 2.0)) * smoothstep(1.7, 2.4, p.y);
               vec3 high = mix(lime, uIn_mold, mold * 0.6);
               c = mix(high, low, band);
               c = mix(c, c * 0.4, line * 0.8);
               // Сырость снизу стены.
               c *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.35, p.y));
               cRough = band > 0.5 ? mix(0.34, 0.8, peel) : 0.92;
               cBumpIn = band > 0.5 ? 0.003 + 0.01 * peel : 0.006;
               // Стена зарубок: задняя стена кают-компании.
               if (abs(room - ${g(ROOM_INDEX.E)}) < 0.5 && n.z > 0.9 && p.x > ${g(NOTCH_WALL.x0)} && p.x < ${g(NOTCH_WALL.x1)} && p.y > ${g(NOTCH_WALL.y0)} && p.y < ${g(NOTCH_WALL.y1)}) {
                 vec2 uv = vec2(p.x - ${g(NOTCH_WALL.x0)}, ${g(NOTCH_WALL.y1)} - p.y);
                 float aa = max(fwidth(uv.x), fwidth(uv.y)) * 0.7;
                 vec2 nt = cNotch(uv, aa);
                 // Царапина снимает краску: под масляной - светлая штукатурка,
                 // по побелке - серая борозда. Свежие светлее.
                 vec3 scratch = band > 0.5 ? mix(vec3(0.42, 0.44, 0.4), vec3(0.62, 0.62, 0.58), nt.y) : mix(vec3(0.26, 0.26, 0.24), vec3(0.4, 0.4, 0.37), nt.y);
                 c = mix(c, scratch, nt.x);
               }
             }
             diffuseColor.rgb = c;
           } else {
           #endif
           float up = n.y;
           float big = wFbm(p * 0.45);
           float fine = wFbm(p * 2.7);
           // Бетон сам по себе неровный: пятна старой опалубки и цементного молока.
           diffuseColor.rgb *= 0.78 + 0.34 * big + 0.12 * (fine - 0.5);

           // Потёки: вытянутый по вертикали шум, гуще к верху стен - вода
           // стекает от кромок, у земли её уже съела сырость.
           float along = abs(n.x) > abs(n.z) ? p.z : p.x;
           float streak = wNoise(vec3(along * 7.0, p.y * 0.35, 0.0));
           streak = smoothstep(0.55, 0.95, streak) * (0.35 + 0.65 * smoothstep(0.4, 2.6, p.y));
           streak *= 1.0 - smoothstep(0.3, 0.7, abs(up));
           diffuseColor.rgb *= 1.0 - 0.45 * streak;

           // Сырость снизу стен: темнее и глаже.
           cDamp = (1.0 - smoothstep(0.08, 0.6 + 0.2 * fine, p.y)) * (1.0 - smoothstep(0.5, 0.9, up));
           diffuseColor.rgb *= 1.0 - 0.4 * cDamp;

           // Мох: сплошной сверху, пятнами на вертикалях, гуще у земли и в нишах.
           float top = smoothstep(0.15, 0.55, up);
           float patches = smoothstep(0.45, 0.75, big * 0.7 + fine * 0.5);
           float low = 1.0 - smoothstep(0.0, 0.9, p.y);
           cMoss = clamp(top * (0.75 + 0.25 * fine) + patches * 0.55 * (1.0 - top) + low * patches * 0.5, 0.0, 1.0);
           // Под навесом сухо: низ плиты мха не держит.
           cMoss *= 1.0 - smoothstep(-0.3, -0.7, up);
           vec3 moss = mix(uMossDark, uMoss, fine);
           diffuseColor.rgb = mix(diffuseColor.rgb, moss, cMoss);
           #ifdef VIGIL_INDOOR
           }
           #endif
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = mix(0.86, 0.5, cDamp);
         roughnessFactor = mix(roughnessFactor, 0.95, cMoss);
         if (cInside > 0.5) roughnessFactor = cRough;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           // Неровность без карты: высота из шума, наклон из производных экрана.
           float h = cHeight(vCWorld) * (cInside > 0.5 ? cBumpIn : 0.012 + 0.02 * cMoss);
           vec3 dpx = dFdx(-vViewPosition);
           vec3 dpy = dFdy(-vViewPosition);
           float dhx = dFdx(h);
           float dhy = dFdy(h);
           vec3 r1 = cross(dpy, normal);
           vec3 r2 = cross(normal, dpx);
           float det = dot(dpx, r1);
           vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
           normal = normalize(abs(det) * normal - grad);
         }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           // Поддельный отсвет трубки на низе навеса и на стене у двери.
           float d = lampDistance(vCWorld);
           vec3 n = normalize(vCNormal);
           float facing = max(0.0, -n.y) + 0.9 * max(0.0, n.z);
           // Вершина плоская: в упор у трубки стена не горит ярче ореола, а
           // разлив держится на метр вокруг двери, как на референсе.
           totalEmissiveRadiance += (1.0 - cInside) * uLampColor * uLampPower * facing * min(0.5, 0.85 * exp(-d * 0.65));
           // Молния сквозь щели ставен: полосы на полу у окон.
           totalEmissiveRadiance += diffuseColor.rgb * vec3(0.55, 0.75, 0.8) * uFlash * cSlit * 1.6;
         }`,
      )
  }
  mat.customProgramCacheKey = () => (inside ? 'vigil-concrete-in' : 'vigil-concrete')
  return inside ? indoor(mat) : mat
}
