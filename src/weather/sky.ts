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
      uClear: { value: 0 },
      uRadius: { value: 1000 },
      uLength: { value: 6000 },
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
      uniform float uClear;
      uniform float uRadius;
      uniform float uLength;
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
        // Ray from the surface to the opposite wall of a cylinder with its axis along X.
        // Directional rendering keeps the distant wall stable while the camera walks.
        float lateral = max(0.001, d.y * d.y + d.z * d.z);
        float travel = 2.0 * uRadius * max(d.y, 0.0) / lateral;
        vec3 hit = vec3(travel * d.x, -uRadius + travel * d.y, travel * d.z);
        float a = atan(hit.z, hit.y);
        vec2 land = vec2(hit.x * 0.001, a * 8.0);
        float mass = n2(land * 1.1) * 0.65 + n2(land * 3.7) * 0.35;
        float water = 1.0 - smoothstep(0.31, 0.38, n2(land * 0.7 + 9.0));
        float growth = smoothstep(0.3, 0.7, mass);
        vec3 terrain = mix(vec3(0.012, 0.032, 0.035), vec3(0.057, 0.111, 0.100), growth);
        terrain = mix(terrain, vec3(0.044, 0.073, 0.082), water * 0.7);
        float border = 1.0 - smoothstep(0.0, 0.006, abs(fract(a * 5.0) - 0.5));
        float lengthwise = 1.0 - smoothstep(0.0, 0.015, abs(fract(hit.x / 480.0) - 0.5));
        terrain += vec3(0.008, 0.016, 0.015) * max(border, lengthwise);
        float axis = exp(-pow(d.z / max(0.01, d.y), 2.0) * 15000.0) * step(0.12, d.y);
        terrain += vec3(0.12, 0.2, 0.19) * axis;
        float endRib = smoothstep(uLength * 0.44, uLength * 0.5, abs(hit.x));
        terrain = mix(terrain, vec3(0.026, 0.043, 0.047) * (0.7 + 0.3 * n2(vec2(a * 40.0, 1.0))), endRib);
        col = mix(col, terrain, uClear * smoothstep(0.015, 0.12, d.y));
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
    setClear(value: number): void { mat.uniforms.uClear.value = Math.max(0, Math.min(1, value)) },
    setShape(radius: number, length: number): void {
      mat.uniforms.uRadius.value = radius
      mat.uniforms.uLength.value = length
    },
    /** Купол ездит за камерой: он бесконечно далеко. */
    follow(camera: THREE.Camera): void {
      mesh.position.copy(camera.position)
    },
  }
}
