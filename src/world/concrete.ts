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
 */

import * as THREE from 'three'
import { LAMP_GLSL, lampUniforms, FLASH } from './shared'

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

/** Альбедо бетона и мха, линейное: середина, темноту даёт туман. */
const CONCRETE = new THREE.Color(0x8a8e85)
const MOSS = new THREE.Color(0x4e6a34)
const MOSS_DARK = new THREE.Color(0x2f4424)

export function concreteMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: CONCRETE, roughness: 0.9, metalness: 0 })
  mat.onBeforeCompile = (shader) => {
    lampUniforms(shader.uniforms)
    shader.uniforms.uMoss = { value: MOSS }
    shader.uniforms.uMossDark = { value: MOSS_DARK }
    shader.uniforms.uFlash = FLASH
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
         float cMoss;
         float cDamp;
         float cHeight(vec3 p) {
           return wFbm(p * 3.1) * 0.6 + wNoise(p * 11.0) * 0.4;
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           vec3 p = vCWorld;
           vec3 n = normalize(vCNormal);
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
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = mix(0.86, 0.5, cDamp);
         roughnessFactor = mix(roughnessFactor, 0.95, cMoss);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           // Неровность без карты: высота из шума, наклон из производных экрана.
           float h = cHeight(vCWorld) * (0.012 + 0.02 * cMoss);
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
           totalEmissiveRadiance += uLampColor * uLampPower * facing * min(0.5, 0.85 * exp(-d * 0.65));
         }`,
      )
  }
  mat.customProgramCacheKey = () => 'vigil-concrete'
  return mat
}
