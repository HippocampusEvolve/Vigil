import * as THREE from 'three'

/** Small camera rig: the right hand carries the torch, the left holds paper. */
export function createHands(scene: THREE.Scene, camera: THREE.Camera) {
  scene.add(camera)
  const root = new THREE.Group()
  camera.add(root)
  const cloth = new THREE.MeshStandardMaterial({ color: 0x464d3c, roughness: 0.95, depthTest: false })
  const skin = new THREE.MeshStandardMaterial({ color: 0x927d6b, roughness: 0.93, depthTest: false })
  const bandage = new THREE.MeshStandardMaterial({ color: 0xb6a589, roughness: 1, depthTest: false })
  const stain = new THREE.MeshStandardMaterial({ color: 0x665044, roughness: 1, depthTest: false })
  const steel = new THREE.MeshStandardMaterial({ color: 0x303733, metalness: 0.65, roughness: 0.4, depthTest: false })
  const lens = new THREE.MeshBasicMaterial({ color: 0xe3d1a6, depthTest: false })
  const limb = (parent: THREE.Group, material: THREE.Material, radius: number, length: number, x: number, y: number, z: number, rz = 0) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.9, radius, length, 9), material)
    mesh.position.set(x, y, z)
    mesh.rotation.z = rz
    mesh.renderOrder = 8
    parent.add(mesh)
    return mesh
  }
  const right = new THREE.Group()
  right.position.set(0.28, -0.34, -0.47)
  limb(right, cloth, 0.085, 0.32, 0.09, -0.08, 0.02, -0.32)
  limb(right, skin, 0.056, 0.18, 0.02, 0.13, -0.03, -0.2)
  limb(right, steel, 0.045, 0.29, 0, 0.22, -0.07, 0.12)
  limb(right, steel, 0.068, 0.08, -0.01, 0.37, -0.08, 0.12)
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.053, 16), lens)
  glass.position.set(-0.012, 0.415, -0.09)
  glass.rotation.x = -Math.PI / 2
  glass.renderOrder = 9
  right.add(glass)
  right.visible = false
  root.add(right)

  const left = new THREE.Group()
  left.position.set(-0.27, -0.37, -0.49)
  limb(left, cloth, 0.084, 0.32, -0.06, -0.06, 0.02, 0.25)
  limb(left, skin, 0.058, 0.18, 0.01, 0.13, -0.03, 0.15)
  for (let i = 0; i < 3; i++) limb(left, bandage, 0.064, 0.027, 0.01, 0.085 + i * 0.035, -0.03, 0.15)
  limb(left, stain, 0.009, 0.012, 0.064, 0.118, -0.03, 0.15)
  const stencil = document.createElement('canvas')
  stencil.width = 128; stencil.height = 64
  const ctx = stencil.getContext('2d')!
  ctx.fillStyle = '#dad9c5'
  ctx.font = 'bold 46px sans-serif'
  ctx.fillText('16', 31, 47)
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.045), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(stencil), transparent: true, depthTest: false, side: THREE.DoubleSide }))
  label.position.set(-0.13, -0.085, 0.065)
  label.rotation.z = -0.24
  label.renderOrder = 9
  left.add(label)
  left.visible = false
  root.add(left)
  let reading = false
  let pouring = false
  return {
    setCarried(v: boolean) { right.visible = v },
    setReading(v: boolean) { reading = v; left.visible = reading || pouring },
    setPouring(v: boolean) { pouring = v; left.visible = reading || pouring; left.position.x = v ? -0.12 : -0.27 },
    update(stride: number) {
      right.position.y = -0.34 + Math.sin(stride) * 0.009
      left.position.y = -0.37 - Math.sin(stride) * 0.006
    },
  }
}
