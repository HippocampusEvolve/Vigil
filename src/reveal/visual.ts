import * as THREE from 'three'

export type RevealWorld = { reveal?: { radius?: number; length?: number; period?: number; farPost?: { elevationDeg?: number; azimuthDeg?: number } }; morse?: { call?: string; answer?: string; farLightUnit?: number }; releaseDate?: string | null; baseDay?: number; arrivals?: string[] }

/** The field is attached to the aperture glass after the second world wave. */
export function createFarField(scene: THREE.Scene, period = 60) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPeriod: { value: period } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uPeriod; varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      void main() {
        vec2 p = (vUv - 0.5) * 48.0;
        p.y += mod(uTime / uPeriod, 1.0) * 48.0;
        vec2 cell = mod(floor(p), 48.0); vec2 f = fract(p) - 0.5;
        float seed = hash(cell);
        vec2 dotAt = vec2(hash(cell + 7.3), hash(cell + 12.7)) - 0.5;
        float star = (1.0 - smoothstep(0.012, 0.08, length(f - dotAt))) * step(0.962, seed);
        float faint = (1.0 - smoothstep(0.02, 0.11, length(f - dotAt))) * step(0.88, seed) * 0.22;
        float redY = -0.2 + mod(uTime / uPeriod, 1.0) * 1.4;
        float red = exp(-length((vUv - vec2(0.61, redY)) * vec2(1.0, 1.0)) * 95.0);
        float milk = exp(-pow((vUv.x - 0.57 + vUv.y * 0.19) * 5.0, 2.0)) * 0.022;
        vec3 color = vec3(0.001,0.004,0.012) + vec3(0.72,0.85,0.95) * (star + faint) + vec3(0.75,0.20,0.12) * red + milk;
        float edge = 1.0 - smoothstep(0.34, 0.49, length(vUv-0.5));
        color *= 0.6 + 0.4 * edge;
        gl_FragColor = vec4(color,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide, depthWrite: true, fog: false,
  })
  const disk = new THREE.Mesh(new THREE.CircleGeometry(0.64, 48), material)
  disk.name = 'far-field'
  disk.rotation.x = -Math.PI / 2
  disk.visible = false
  scene.add(disk)
  return {
    show(position: THREE.Vector3): void { disk.position.copy(position).add(new THREE.Vector3(0, 0.006, 0)); disk.visible = true },
    update(dt: number): void { material.uniforms.uTime.value += dt },
    get mesh(): THREE.Mesh { return disk },
  }
}

export function createFarLight(scene: THREE.Scene, elevationDeg = 45, azimuthDeg = 0) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const c = canvas.getContext('2d')!
  const g = c.createRadialGradient(32, 32, 1, 32, 32, 32)
  g.addColorStop(0, '#e4ffe0'); g.addColorStop(0.08, '#7dffad'); g.addColorStop(0.26, '#26b96d88'); g.addColorStop(1, '#0b352700')
  c.fillStyle = g; c.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthTest: true, depthWrite: false, fog: false })
  const sprite = new THREE.Sprite(material)
  sprite.name = 'far-light'
  sprite.scale.set(4, 4, 1)
  scene.add(sprite)
  const elevation = elevationDeg * Math.PI / 180
  const azimuth = azimuthDeg * Math.PI / 180
  const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation))
  return {
    update(camera: THREE.Camera, brightness: number, reveal: number): void {
      sprite.position.copy(camera.position).addScaledVector(direction, 300)
      material.opacity = Math.max(0, Math.min(1, brightness * reveal))
    },
    observed(camera: THREE.Camera): boolean { return camera.getWorldDirection(new THREE.Vector3()).dot(direction) >= Math.cos(20 * Math.PI / 180) },
    /** Direction to the distant source; position itself follows the camera. */
    direction,
    get sprite(): THREE.Sprite { return sprite },
  }
}
