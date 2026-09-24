import * as THREE from 'three'
import type { Ambient } from '../ambient'
import type { Inside } from '../world/inside'
import { furnishMaterials } from '../world/furnish-materials'

/** A 256-sample oscilloscope trace, refreshed at 30 Hz. */
export function createDisplay(inside: Inside, ambient: Ambient) {
  const placed = inside.furnish.placed.get('console')
  const panel = placed?.group.getObjectByName('console-panel')
  if (!panel) return { update: (_dt: number, _channel: number) => {} }

  // A thin dynamic ribbon uses the shared, already warmed fixture glow shader.
  // A separate screen shader stalled SwiftShader on its first frame.
  const positions = new Float32Array(256 * 2 * 3)
  const colors = new Float32Array(256 * 2 * 3)
  const surf = new Float32Array(256 * 2 * 4)
  const indices = new Uint16Array(255 * 6)
  for (let i = 0; i < 256 * 2; i++) {
    colors.set([0.8, 3, 1.2], i * 3)
    surf[i * 4 + 3] = -1
  }
  for (let i = 0; i < 255; i++) {
    const p = i * 6, v = i * 2
    indices.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], p)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('surf', new THREE.BufferAttribute(surf, 4))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const screen = new THREE.Mesh(geometry, furnishMaterials().glow)
  screen.name = 'console-live-screen'
  screen.frustumCulled = false
  panel.add(screen)
  const values = new Float32Array(256)
  const smooth = new Float32Array(256)
  let elapsed = 0
  return {
    update(dt: number, channel: number) {
      elapsed += dt
      if (elapsed < 1 / 30) return
      elapsed = 0
      ambient.analyser?.getFloatTimeDomainData(values)
      let peak = 0
      for (let i = 0; i < 256; i++) {
        let sum = 0
        for (let j = -3; j <= 3; j++) sum += values[Math.max(0, Math.min(255, i + j))]
        smooth[i] = sum / 7
        peak = Math.max(peak, Math.abs(smooth[i]))
      }
      const scale = channel && peak > 0.0001 ? 0.045 / peak : 0
      for (let i = 0; i < 256; i++) {
        const x = 0.95 + (i / 255 - 0.5) * 0.19
        const z = -0.24 + smooth[i] * scale
        const p = i * 6
        positions.set([x, 0.032, z - 0.003, x, 0.032, z + 0.003], p)
      }
      geometry.attributes.position.needsUpdate = true
      const moving = inside.furnish.moving
      for (let i = 1; i <= 6; i++) {
        const needle = moving.get(`console/needle-${i}`)
        if (needle) needle.rotation.y = channel === i ? 0.5 + Math.sin(performance.now() * 0.023) * 0.1 : 0.68
      }
    },
  }
}
