/**
 * weather/sky.ts — облачный купол над лесом.
 *
 * Купол - фон кадра там, где нет ни леса, ни поста. У горизонта он ровно
 * цвета тумана, иначе край леса читался бы полосой; выше по нему ползут
 * медленные облака чуть светлее и темнее тумана. При молнии купол
 * подсвечивается изнутри большими мягкими пятнами с той стороны, где ударило.
 *
 * Туман на купол не действует: он и есть цвет тумана, только живой.
 */

import * as THREE from 'three'
import { FLASH, RAIN_TIME } from '../world/shared'

/** Радиус купола: внутри дальней плоскости камеры. */
export const SKY_RADIUS = 380

export function createSky(fogColor: THREE.Color) {
  const geo = new THREE.SphereGeometry(SKY_RADIUS, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.62)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uFog: { value: fogColor },
      uTime: RAIN_TIME,
      uFlash: FLASH,
      uFlashDir: { value: new THREE.Vector3(0, 0.5, -1).normalize() },
      uFlashGain: { value: 10 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_Position.z = gl_Position.w * 0.9999;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uFog;
      uniform float uTime;
      uniform float uFlash;
      uniform vec3 uFlashDir;
      uniform float uFlashGain;
      varying vec3 vDir;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        // Облака на плоскости над головой: чем выше взгляд, тем крупнее рисунок.
        vec2 q = d.xz / (0.25 + up) * 1.6 + vec2(uTime * 0.012, uTime * 0.007);
        float c = n2(q) * 0.6 + n2(q * 2.3 + 4.1) * 0.3 + n2(q * 5.1 + 9.7) * 0.1;
        float band = smoothstep(0.02, 0.35, up);
        vec3 col = uFog * (1.0 + band * (c - 0.5) * 0.35);
        // Молния: мягкое пятно в сторону удара и общий подъём купола.
        float spot = pow(max(dot(d, uFlashDir), 0.0), 3.0);
        col *= 1.0 + uFlash * uFlashGain * (0.35 + 0.65 * spot) * (0.6 + 0.4 * c);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'sky'
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  return {
    mesh,
    /** Куда ударило и насколько ярче купол во вспышке (8-15 раз). */
    setStrike(azimuth: number, gain: number): void {
      mat.uniforms.uFlashDir.value.set(Math.sin(azimuth), 0.45, -Math.cos(azimuth)).normalize()
      mat.uniforms.uFlashGain.value = gain
    },
    /** Купол ездит за камерой: он бесконечно далеко. */
    follow(camera: THREE.Camera): void {
      mesh.position.copy(camera.position)
    },
  }
}
