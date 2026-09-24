/**
 * world/furnish-materials.ts — три программы предметов нутра: непрозрачное,
 * стекло, свечение.
 *
 * Отдельно от расстановки (`furnish.ts`) по одной причине: материалы нужны
 * прогреву входа (main.ts), а расстановка с каталогом ядра - только второй
 * волне. Каталог и опись предметов - треть бандла мира; лежи материалы рядом
 * с ними, каталог ехал бы в критическом пути входа ради трёх материалов.
 * Здесь - только то, что нужно, чтобы собрать программы: краски шейдером и
 * свет нутра.
 */

import * as THREE from 'three'
import { indoor } from './indoor'
import { NOISE_GLSL } from './concrete'
import { FIXTURES } from './zones'

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
           } else if (kind > 13.5) {
             // Погасшая трубка: по развёртке вдоль неё (V от 0 до длины) концы
             // в тёмных ожогах, середина - серый люминофор.
             float v = vPUv.y;
             float burn = 1.0 - smoothstep(0.02, 0.13, min(v, vSurf.w - v));
             c = mix(c * (0.9 + 0.1 * big), vec3(0.05, 0.045, 0.04), burn * 0.9);
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
  // Прозрачность - в цвете вершины (у банки одна, у крышки капсулы другая).
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0, transparent: true, opacity: 1, depthWrite: false })
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

export type FurnishMaterials = { opaque: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial; glow: THREE.ShaderMaterial }

/** Пока мир не отдал силу светильников, свечение горит ровно. */
const STEADY = { value: FIXTURES.map(() => 1) }
let shared: FurnishMaterials | null = null

/**
 * Материалы предметов: одни на всё нутро, созданы один раз. Их программы
 * можно собрать заранее, вместе с первой волной (main.ts, прогрев): сами
 * предметы для этого не нужны, хватит держателя с атрибутом цвета.
 *
 * `power` - сила светильников по порядку FIXTURES (`lights.glow`): с ней
 * свечение трубок мигает вместе с их светом.
 */
export function furnishMaterials(power?: { value: number[] }): FurnishMaterials {
  if (!shared) shared = { opaque: propMaterial(), glass: glassMaterial(), glow: glowMaterial(STEADY) }
  if (power) shared.glow.uniforms.uPower = power
  return shared
}
