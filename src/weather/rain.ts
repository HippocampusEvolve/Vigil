/**
 * weather/rain.ts — ливень: струи вокруг камеры, всплески на земле, капель
 * с навеса и карниза, струя водостока.
 *
 * Капля - это блик, а не вода: в темноте её видно только там, где на неё
 * падает свет. Поэтому цвет каждой струи считает шейдер по тем же лампам,
 * что светят сцене: у двери капли зелёные - перед входом висит зелёная завеса
 * ливня, главный образ референса; в луче фонаря - тёплые; вдали от света -
 * еле различимая серая штриховка. Свет сцены сам капли не красит: капель
 * тысячи, а источников сцены четыре, и считать их дважды незачем.
 *
 * Под крышами дождя нет: струя гаснет, попав в рамку навеса или поста ниже
 * их верха. Рамки - из layout.ts.
 */

import * as THREE from 'three'
import { BLOCK, CANOPY, GUTTER, HANGAR, PLINTH, WATER_TANK } from '../world/layout'
import { heightAt } from '../world/terrain'
import { FLASH, LAMP, LAMP_GLSL, RAIN_TIME, lampUniforms } from '../world/shared'

/** Фонарь для шейдеров капель: положение, направление, конус, сила. */
export const TORCH = {
  pos: { value: new THREE.Vector3() },
  dir: { value: new THREE.Vector3(0, 0, -1) },
  cos: { value: Math.cos((22 * Math.PI) / 180) },
  color: { value: new THREE.Color(0xffe2c0) },
  power: { value: 0 },
}

/** Струи: цилиндр вокруг камеры, м. */
const RADIUS = 25
/** Высота столба струй: от земли до `TOP` над камерой. */
const TOP = 12
const SPAN = 18
/** Скорость падения, м/с, и снос ветром (тангенс наклона, 4-8°). */
const SPEED = 10
const WIND = new THREE.Vector2(Math.tan((6 * Math.PI) / 180) * 0.8, Math.tan((6 * Math.PI) / 180) * 0.6)

/**
 * Рамки, под которыми сухо: [x0, z0, x1, z1] и высота верха. Навес, блок,
 * ангар по гребню - грубо, но струя под сводом и так не видна снаружи.
 */
const ROOFS: Array<[number, number, number, number, number]> = [
  [CANOPY.x0, CANOPY.z0, CANOPY.x1, CANOPY.z1, CANOPY.y + CANOPY.thick],
  [BLOCK.x0, BLOCK.z0, BLOCK.x1, BLOCK.z1, BLOCK.height + BLOCK.parapet],
  [HANGAR.x0, HANGAR.z0, HANGAR.x1, HANGAR.z1, HANGAR.ridge],
]

const SHELTER_GLSL = /* glsl */ `
  uniform vec4 uRoofRect[${ROOFS.length}];
  uniform float uRoofTop[${ROOFS.length}];
  float sheltered(vec3 p) {
    for (int i = 0; i < ${ROOFS.length}; i++) {
      vec4 r = uRoofRect[i];
      if (p.x > r.x && p.x < r.z && p.z > r.y && p.z < r.w && p.y < uRoofTop[i]) return 1.0;
    }
    return 0.0;
  }
`

/** Свет на капле: лампа, фонарь, вспышка неба и слабый общий. */
const LIGHT_GLSL = /* glsl */ `
  ${LAMP_GLSL}
  uniform vec3 uTorchPos;
  uniform vec3 uTorchDir;
  uniform float uTorchCos;
  uniform vec3 uTorchColor;
  uniform float uTorchPower;
  uniform float uFlash;
  vec3 dropLight(vec3 p) {
    // Лампа: сверху и спереди от трубки капля горит, за стеной - нет.
    float d = lampDistance(p);
    float front = smoothstep(-0.2, 0.4, p.z - uLampA.z);
    vec3 lamp = uLampColor * uLampPower * front * (1.4 / (0.35 + d * d)) * exp(-d * 0.22);
    // Фонарь: в конусе луча капли ярче всего.
    vec3 tp = p - uTorchPos;
    float td = length(tp);
    float cone = smoothstep(uTorchCos - 0.08, uTorchCos + 0.04, dot(tp / max(td, 1e-3), uTorchDir));
    vec3 torch = uTorchColor * uTorchPower * cone * (1.5 / (1.0 + td * td * 0.5));
    return lamp + torch + vec3(0.05, 0.09, 0.09) * (0.35 + 6.0 * uFlash);
  }
`

function shelterUniforms(): Record<string, THREE.IUniform> {
  return {
    uRoofRect: { value: ROOFS.map(([x0, z0, x1, z1]) => new THREE.Vector4(x0, z0, x1, z1)) },
    uRoofTop: { value: ROOFS.map((r) => r[4]) },
  }
}

function lightUniforms(): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = {
    uTorchPos: TORCH.pos,
    uTorchDir: TORCH.dir,
    uTorchCos: TORCH.cos,
    uTorchColor: TORCH.color,
    uTorchPower: TORCH.power,
    uFlash: FLASH,
  }
  lampUniforms(u)
  return u
}

/** Струи ливня: инстансные ленты, повёрнутые к камере вдоль падения. */
function streaks(count: number): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1)
  geo.translate(0, 0.5, 0)
  const seeds = new Float32Array(count * 4)
  let s = 12345
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = rnd()
    seeds[i * 4 + 1] = rnd()
    seeds[i * 4 + 2] = rnd()
    seeds[i * 4 + 3] = rnd()
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4))
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uCam: { value: new THREE.Vector3() },
        uWind: { value: WIND },
        uIntensity: { value: 1 },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform vec3 uCam;
      uniform vec2 uWind;
      uniform float uIntensity;
      attribute vec4 aSeed;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vAcross;
      ${SHELTER_GLSL}
      ${LIGHT_GLSL}
      void main() {
        // Каждая струя живёт в своей клетке квадрата вокруг камеры и падает
        // по кругу: сверху вниз, потом снова сверху.
        vec2 cell = (aSeed.xy - 0.5) * 2.0 * ${RADIUS.toFixed(1)};
        vec2 base = mod(cell - uCam.xz + ${RADIUS.toFixed(1)}, ${(2 * RADIUS).toFixed(1)}) - ${RADIUS.toFixed(1)} + uCam.xz;
        float fall = fract(aSeed.z + uTime * ${SPEED.toFixed(1)} / ${SPAN.toFixed(1)});
        float drop = fall * ${SPAN.toFixed(1)};
        vec3 head = vec3(base.x + uWind.x * drop, uCam.y + ${TOP.toFixed(1)} - drop, base.y + uWind.y * drop);
        vec3 vel = normalize(vec3(uWind.x, -1.0, uWind.y));
        float len = 0.35 + 0.25 * aSeed.w;
        vec3 p = head - vel * len * position.y;
        vec3 toCam = normalize(uCam - p);
        vec3 side = normalize(cross(vel, toCam));
        float dist = length(uCam - p);
        // Вдали струя тоньше пикселя: её расширяем и гасим, иначе рябь.
        float width = 0.006 + dist * 0.0009;
        p += side * position.x * width;
        vAcross = position.x * 2.0;

        float radial = length(p.xz - uCam.xz);
        vAlpha = (1.0 - smoothstep(${(RADIUS * 0.7).toFixed(1)}, ${RADIUS.toFixed(1)}, radial))
               * step(aSeed.w, uIntensity)
               * (1.0 - sheltered(head))
               * step(-0.2, head.y)
               * (0.35 + 0.65 * position.y) * (1.0 - 0.6 * smoothstep(8.0, 25.0, dist));
        vColor = dropLight(p);

        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vFogDepth = - mvPosition.z;
        vFogWorld = p;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      varying vec3 vColor;
      varying float vAlpha;
      varying float vAcross;
      void main() {
        float a = vAlpha * (1.0 - abs(vAcross));
        vec3 c = vColor * a;
        gl_FragColor = vec4(c, 1.0);
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          gl_FragColor.rgb *= 1.0 - fogFactor;
        #endif
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Лента поворачивается к камере в шейдере: сторона зависит от ракурса.
    side: THREE.DoubleSide,
    fog: true,
  })
  mat.uniforms.uTime = RAIN_TIME
  Object.assign(mat.uniforms, shelterUniforms(), lightUniforms())
  const mesh = new THREE.InstancedMesh(geo, mat, count)
  mesh.frustumCulled = false
  mesh.name = 'rain'
  return mesh
}

/**
 * Всплески: пул колец на земле вокруг камеры. Живёт всплеск 0.15-0.3 с, и
 * место ему выбирается на процессоре заново при каждом рождении - высота
 * земли нужна настоящая, а считать `heightAt` в шейдере значило бы держать
 * вторую копию рельефа.
 */
function splashes(count: number) {
  const geo = new THREE.PlaneGeometry(1, 1)
  geo.rotateX(-Math.PI / 2)
  const pos = new Float32Array(count * 4)
  const born = new Float32Array(count * 2)
  const aPos = new THREE.InstancedBufferAttribute(pos, 4)
  const aBorn = new THREE.InstancedBufferAttribute(born, 2)
  aPos.setUsage(THREE.DynamicDrawUsage)
  aBorn.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aPos', aPos)
  geo.setAttribute('aBorn', aBorn)
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uTime;
      attribute vec4 aPos;
      attribute vec2 aBorn;
      varying vec2 vUv;
      varying float vAge;
      varying vec3 vColor;
      ${LIGHT_GLSL}
      void main() {
        vAge = clamp((uTime - aBorn.x) / aBorn.y, 0.0, 1.0);
        vUv = position.xz * 2.0;
        float size = aPos.w * (0.4 + 0.9 * vAge);
        vec3 p = aPos.xyz + vec3(position.x * size, 0.012, position.z * size);
        vColor = dropLight(p + vec3(0.0, 0.15, 0.0));
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vFogDepth = - mvPosition.z;
        vFogWorld = p;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      varying vec2 vUv;
      varying float vAge;
      varying vec3 vColor;
      void main() {
        float r = length(vUv);
        float ring = smoothstep(0.12, 0.0, abs(r - 0.25 - 0.6 * vAge)) * (1.0 - vAge);
        float core = smoothstep(0.35, 0.0, r) * (1.0 - vAge) * (1.0 - vAge) * 0.6;
        float a = (ring + core) * step(r, 1.0);
        vec3 c = vColor * a * 0.9;
        #ifdef USE_FOG
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          c *= 1.0 - fogFactor;
        #endif
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  })
  mat.uniforms.uTime = RAIN_TIME
  Object.assign(mat.uniforms, lightUniforms())
  const mesh = new THREE.InstancedMesh(geo, mat, count)
  mesh.frustumCulled = false
  mesh.name = 'splashes'

  let seed = 777
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const SPLASH_R = 12
  /** Родить всплеск: у воронки водостока - чаще, чем где-либо. */
  function spawn(i: number, cx: number, cz: number, now: number): void {
    let x: number
    let z: number
    let size = 0.05 + rnd() * 0.07
    if (i % 25 === 0) {
      const a = rnd() * Math.PI * 2
      const d = rnd() * 0.35
      x = GUTTER.x + Math.cos(a) * d
      z = GUTTER.z + Math.sin(a) * d
      size *= 1.8
    } else {
      const a = rnd() * Math.PI * 2
      const d = Math.sqrt(rnd()) * SPLASH_R
      x = cx + Math.cos(a) * d
      z = cz + Math.sin(a) * d
      // Под навесом и под крышами земля сухая: там не брызжет.
      for (const [x0, z0, x1, z1] of ROOFS) {
        if (x > x0 && x < x1 && z > z0 && z < z1) {
          size = 0
          break
        }
      }
    }
    pos[i * 4] = x
    pos[i * 4 + 1] = heightAt(x, z)
    pos[i * 4 + 2] = z
    pos[i * 4 + 3] = size
    born[i * 2] = now + rnd() * 0.05
    born[i * 2 + 1] = 0.15 + rnd() * 0.15
  }

  let started = false
  return {
    mesh,
    update(cx: number, cz: number, now: number, intensity: number): void {
      const live = Math.floor(count * intensity)
      for (let i = 0; i < count; i++) {
        if (!started || now > born[i * 2] + born[i * 2 + 1]) {
          if (i < live) spawn(i, cx, cz, now)
          else pos[i * 4 + 3] = 0
        }
      }
      started = true
      aPos.needsUpdate = true
      aBorn.needsUpdate = true
    },
  }
}

/**
 * Капель: столбики капель с кромки навеса, с карниза ангара и с перелива
 * бака. Капля падает с ускорением: медленно срывается, быстро летит.
 */
function drips(): THREE.InstancedMesh {
  type Column = [number, number, number, number]
  const cols: Column[] = []
  for (let x = CANOPY.x0 + 0.05; x < CANOPY.x1; x += 0.15) cols.push([x, CANOPY.y, CANOPY.z1 + 0.02, heightAt(x, CANOPY.z1 + 0.02)])
  for (let z = CANOPY.z0 + 0.3; z < CANOPY.z1; z += 0.3) cols.push([CANOPY.x1 + 0.02, CANOPY.y, z, heightAt(CANOPY.x1 + 0.02, z)])
  for (let x = HANGAR.x0 + 0.3; x < HANGAR.x1 - 0.3; x += 0.5) cols.push([x, HANGAR.wall - 0.02, HANGAR.z1 + 0.1, heightAt(x, HANGAR.z1 + 0.1)])
  cols.push([WATER_TANK.x + WATER_TANK.diameter / 2 + 0.12, 0.55, WATER_TANK.z + 0.2, heightAt(WATER_TANK.x + 0.82, WATER_TANK.z + 0.2)])
  const perColumn = 2
  const count = cols.length * perColumn
  const data = new Float32Array(count * 4)
  const extra = new Float32Array(count * 2)
  cols.forEach(([x, top, z, bottom], i) => {
    for (let k = 0; k < perColumn; k++) {
      const j = i * perColumn + k
      data[j * 4] = x
      data[j * 4 + 1] = top
      data[j * 4 + 2] = z
      data[j * 4 + 3] = Math.max(bottom, x > PLINTH.x0 && x < PLINTH.x1 && z < PLINTH.z1 ? PLINTH.top : bottom)
      extra[j * 2] = ((i * 0.618 + k * 0.5) % 1) + 0.0
      extra[j * 2 + 1] = 0.7 + ((i * 0.37) % 1) * 0.9
    }
  })
  const geo = new THREE.PlaneGeometry(1, 1)
  geo.translate(0, 0.5, 0)
  geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(data, 4))
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(extra, 2))
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uCam: { value: new THREE.Vector3() } }]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform vec3 uCam;
      attribute vec4 aCol;
      attribute vec2 aPhase;
      varying vec3 vColor;
      varying float vAcross;
      varying float vAlpha;
      ${LIGHT_GLSL}
      void main() {
        float h = aCol.y - aCol.w;
        float fallTime = sqrt(2.0 * h / 9.8);
        // Капля копится на кромке, срывается и падает: цикл длиннее падения.
        float cycle = fallTime + aPhase.y;
        float t = mod(uTime + aPhase.x * cycle, cycle) - aPhase.y;
        float y = aCol.y - 0.5 * 9.8 * max(t, 0.0) * max(t, 0.0);
        float speed = 9.8 * max(t, 0.0);
        float len = clamp(speed * 0.022, 0.02, 0.3);
        vec3 head = vec3(aCol.x, y, aCol.z);
        vec3 p = head + vec3(0.0, len * position.y, 0.0);
        vec3 toCam = normalize(uCam - p);
        vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        float dist = length(uCam - p);
        p += side * position.x * (0.007 + dist * 0.0008);
        vAcross = position.x * 2.0;
        vAlpha = step(0.0, t) * step(aCol.w, y) * (0.5 + 0.5 * position.y);
        vColor = dropLight(p) * 1.3;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vFogDepth = - mvPosition.z;
        vFogWorld = p;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      varying vec3 vColor;
      varying float vAcross;
      varying float vAlpha;
      void main() {
        vec3 c = vColor * vAlpha * (1.0 - abs(vAcross));
        #ifdef USE_FOG
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          c *= 1.0 - fogFactor;
        #endif
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  })
  mat.uniforms.uTime = RAIN_TIME
  Object.assign(mat.uniforms, lightUniforms())
  const mesh = new THREE.InstancedMesh(geo, mat, count)
  mesh.frustumCulled = false
  mesh.name = 'drips'
  return mesh
}

/** Струя водостока: лента к камере с бегущим шумом, расширяется книзу. */
function gutterStream(): THREE.Mesh {
  const top = GUTTER.mouth
  const bottom = heightAt(GUTTER.x, GUTTER.z)
  const geo = new THREE.PlaneGeometry(1, 1, 1, 12)
  geo.translate(0, -0.5, 0)
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uCam: { value: new THREE.Vector3() },
        uTop: { value: new THREE.Vector3(GUTTER.x, top, GUTTER.z) },
        uFall: { value: top - bottom },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform vec3 uCam;
      uniform vec3 uTop;
      uniform float uFall;
      varying vec2 vUv;
      varying vec3 vColor;
      ${LIGHT_GLSL}
      void main() {
        float t = -position.y;
        vec3 axis = uTop + vec3(0.02 * t * t, -uFall * t, 0.05 * t * t);
        vec3 toCam = normalize(uCam - axis);
        vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        float w = 0.05 + 0.07 * t;
        vec3 p = axis + side * position.x * w;
        vUv = vec2(position.x * 2.0, t);
        vColor = dropLight(p) * 1.4 + vec3(0.02, 0.035, 0.035);
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vFogDepth = - mvPosition.z;
        vFogWorld = p;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vColor;
      float h1(float n) { return fract(sin(n) * 43758.5453); }
      float n1(float x) { float i = floor(x); float f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
      void main() {
        // Вода бежит вниз: полосы по высоте сдвигаются со временем.
        float flow = n1(vUv.y * 22.0 - uTime * 30.0 + vUv.x * 3.0) * 0.6 + n1(vUv.y * 55.0 - uTime * 48.0) * 0.4;
        float edge = 1.0 - smoothstep(0.35, 1.0, abs(vUv.x));
        float a = edge * (0.35 + 0.65 * flow) * (0.55 + 0.45 * (1.0 - vUv.y));
        vec3 c = vColor * a;
        #ifdef USE_FOG
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          c *= 1.0 - fogFactor;
        #endif
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  })
  mat.uniforms.uTime = RAIN_TIME
  Object.assign(mat.uniforms, lightUniforms())
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.name = 'gutter-stream'
  return mesh
}

export type Rain = ReturnType<typeof createRain>

/** Ливень целиком. `count` - струй: 10 тыс. на компьютере, 4 тыс. на телефоне. */
export function createRain(count: number) {
  const group = new THREE.Group()
  group.name = 'rain'
  const rain = streaks(count)
  const splash = splashes(Math.round(count * 0.05))
  const drip = drips()
  const gutter = gutterStream()
  group.add(rain, splash.mesh, drip, gutter)
  const cams = [rain, drip, gutter].map((m) => (m.material as THREE.ShaderMaterial).uniforms.uCam)
  let intensity = 1

  return {
    group,
    /** Сила дождя 0..1: доля живых струй и всплесков. */
    setIntensity(v: number): void {
      intensity = Math.min(1, Math.max(0, v))
      group.visible = intensity > 0.001
      ;(rain.material as THREE.ShaderMaterial).uniforms.uIntensity.value = intensity
    },
    /** Сколько струй рисовать: для телефона и для сбережения кадра. */
    setCount(n: number): void {
      rain.count = Math.max(1, Math.min(count, Math.round(n)))
    },
    update(camera: THREE.Camera): void {
      for (const u of cams) u.value.copy(camera.position)
      splash.update(camera.position.x, camera.position.z, RAIN_TIME.value, intensity)
    },
  }
}

export { LAMP }
