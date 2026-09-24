/**
 * world/inside.ts — нутро второй волной: коробка, предметы, твёрдое.
 *
 * До двери игроку не меньше двух минут (tech.md, «Порядок загрузки»), поэтому
 * нутро не стоит в критическом пути входа: первый кадр - поляна и фасад, а
 * нутро собирается уже во время игры, порциями между кадрами, и приходит в
 * мир целиком, когда готово. Пока его нет, входная дверь заперта.
 *
 * Материалы - те же, что у фасада: бетон один на пост изнутри и снаружи,
 * сталь одна на все мелочи. Их программы собраны к первому кадру, и нутро не
 * добавляет ни одной, кроме трёх своих у предметов (`furnishMaterials`).
 *
 * `power` - сила светильников (`lights.glow`): с ней свечение трубок мигает
 * вместе с их светом. Без неё - та, что отдана `furnishMaterials` раньше.
 */

import * as THREE from 'three'
import { buildInteriorSteps, type Interior } from './interior'
import { furnishSteps, type Furnish } from './furnish'

export type Inside = {
  group: THREE.Group
  interior: Interior
  furnish: Furnish
  /** Твёрдое нутра одним мешем: из него строится второе дерево коллизий. */
  solid: THREE.Group
  /**
   * Верх перил над люком (`Interior.hatchRail`): виден, только пока люк
   * открыт, - закрытая крышка легла бы на него. Видимость ставит main.ts.
   */
  hatchRail: THREE.Mesh
}

export function* buildInsideSteps(
  materials: { concrete: THREE.Material; metal: THREE.Material; glass: THREE.Material },
  power?: { value: number[] },
): Generator<string, Inside, void> {
  const steps = buildInteriorSteps()
  let interior: Interior
  for (let k = 1; ; k++) {
    const r = steps.next()
    if (r.done) {
      interior = r.value
      break
    }
    yield `нутро ${k}`
  }
  const group = new THREE.Group()
  group.name = 'inside'
  const concrete = new THREE.Mesh(interior.concrete, materials.concrete)
  concrete.name = 'inside-concrete'
  concrete.receiveShadow = true
  concrete.castShadow = true
  const metal = new THREE.Mesh(interior.metal, materials.metal)
  metal.name = 'inside-metal'
  metal.receiveShadow = true
  metal.castShadow = true
  const hatchRail = new THREE.Mesh(interior.hatchRail, materials.metal)
  hatchRail.name = 'inside-hatch-rail'
  hatchRail.receiveShadow = true
  hatchRail.castShadow = true
  hatchRail.visible = false
  group.add(concrete, metal, hatchRail)
  yield 'нутро: сборка'

  const fs = furnishSteps(materials, undefined, power)
  let furnish: Furnish
  for (;;) {
    const r = fs.next()
    if (r.done) {
      furnish = r.value
      break
    }
    yield 'предметы'
  }
  group.add(furnish.group)

  const solid = new THREE.Group()
  solid.name = 'inside-solid'
  const hidden = new THREE.MeshBasicMaterial({ visible: false })
  const colliders = new THREE.Mesh(interior.colliders, hidden)
  colliders.name = 'inside-colliders'
  solid.add(colliders)
  if (furnish.colliders.attributes.position) {
    const props = new THREE.Mesh(furnish.colliders, hidden)
    props.name = 'furnish-colliders'
    solid.add(props)
  }
  return { group, interior, furnish, solid, hatchRail }
}
