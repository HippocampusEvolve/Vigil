import * as THREE from 'three'
import { turn } from 'world-core/props'
import type { Ambient } from '../ambient'
import type { Layer } from '../layer/read'
import type { Inside } from '../world/inside'
import type { World } from '../world'
import { DOOR, FLASHLIGHT_REST, INTERCOM, LAMP_SWITCH } from '../world/layout'
import { heightAt } from '../world/terrain'
import { Actions, type ActionEvent, type Target } from './state'
import { createReading } from './reading'
import { createDisplay } from './display'
import { createHands } from './hands'
import { scheduleTape, type TapeCue, type StepTrack } from './tape'

type NotePlacement = { id: string; item: string; at: [number, number, number] }
type Hotspot = { id: Target; at: () => THREE.Vector3; reach: number; paper?: THREE.Mesh }

export function createInteractions(opts: {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  world: World
  ambient: Ambient
  layer: Layer
  actions: Actions
  steps: StepTrack
  onEvent(event: ActionEvent): void
  allow?(target: Target): boolean
  journalLines?: () => string[]
  journalDay?: number
}) {
  const { scene, camera, world, ambient, layer, actions, steps, onEvent, allow = () => true, journalLines = () => [], journalDay } = opts
  const texts = layer.get<{ notes?: Record<string, { lines: string[]; decay: number }>; journal?: string[][][] }>('texts')
  const placements = layer.get<{ notes?: NotePlacement[] }>('placements')
  const hands = createHands(scene, camera)
  let inside: Inside | null = null
  let display: ReturnType<typeof createDisplay> | null = null
  const fwd = new THREE.Vector3()
  const eye = new THREE.Vector3()
  const delta = new THREE.Vector3()
  const hint = document.createElement('div')
  hint.id = 'action-hint'
  hint.setAttribute('aria-live', 'polite')
  document.body.append(hint)
  const status = document.createElement('div')
  status.id = 'channel-status'
  document.body.append(status)
  const css = document.createElement('style')
  css.textContent = `
    #action-hint { position:fixed; left:50%; bottom:max(35px,env(safe-area-inset-bottom)); transform:translateX(-50%);
      z-index:5; color:#e3e7d9; background:#06100cbb; padding:8px 17px; border:1px solid #86ad9855;
      font:500 17px/1.2 system-ui; letter-spacing:.05em; text-transform:lowercase; pointer-events:none;
      opacity:0; transition:opacity .16s; }
    #action-hint.on { opacity:1 }
    #channel-status { position:fixed; left:50%; bottom:83px; transform:translateX(-50%); z-index:5;
      color:#b8d5b9; font:500 15px/1.2 monospace; text-shadow:0 2px 8px #000; pointer-events:none; }
    body.touch-mode #action-hint { bottom:99px; }
    body.touch-mode #channel-status { bottom:139px; }
  `
  document.head.append(css)
  const read = createReading(texts, () => act(), journalLines, journalDay)
  const hotspots: Hotspot[] = [
    { id: 'flashlight', at: () => new THREE.Vector3(FLASHLIGHT_REST.x, heightAt(FLASHLIGHT_REST.x, FLASHLIGHT_REST.z) + 0.09, FLASHLIGHT_REST.z), reach: 2.2 },
    { id: 'intercom', at: () => new THREE.Vector3(INTERCOM.x, INTERCOM.y - 0.04, 0.07), reach: 2.0 },
    { id: 'lamp:switch', at: () => new THREE.Vector3(LAMP_SWITCH.x, LAMP_SWITCH.y, 0.12), reach: 2.0 },
  ]
  function at(item: string, key?: string): THREE.Vector3 {
    const p = inside?.furnish.placed.get(item)
    if (!p) return new THREE.Vector3(999, 999, 999)
    const local = key && p.made[key] instanceof THREE.Vector3 ? (p.made[key] as THREE.Vector3).clone() : new THREE.Vector3(0, (p.made.h as number | undefined) ?? 0.05, 0)
    return p.group.localToWorld(local)
  }
  function withOffset(item: string, offset: [number, number, number]): THREE.Vector3 {
    const p = inside?.furnish.placed.get(item)
    return p ? p.group.localToWorld(new THREE.Vector3(...offset)) : new THREE.Vector3(999, 999, 999)
  }
  function setInside(value: Inside): void {
    inside = value
    display = createDisplay(value, ambient)
    hotspots.push(
      { id: 'journal', at: () => at('journal'), reach: 2.1 },
      { id: 'pen', at: () => at('pen'), reach: 2.1 },
      { id: 'console', at: () => at('console', 'selector'), reach: 2.2 },
      { id: 'generator:filler', at: () => at('generator', 'filler'), reach: 2.1 },
      { id: 'generator:lever', at: () => at('generator', 'lever'), reach: 2.1 },
      { id: 'crate', at: () => withOffset('crate', [0, 0.28, 0.32]), reach: 2.3 },
      { id: 'wheel', at: () => at('porthole', 'top'), reach: 2.3 },
      { id: 'tarp', at: () => at('tarp'), reach: 2.2 },
      { id: 'climate:lever', at: () => at('climate', 'lever'), reach: 2.2 },
    )
    if (placements?.notes) {
      const paperMaterial = new THREE.MeshBasicMaterial({ color: 0xc7b897, fog: false })
      for (const note of placements.notes) {
        const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.14), paperMaterial)
        paper.name = `paper-${note.id}`
        paper.rotation.x = -Math.PI / 2
        paper.position.copy(withOffset(note.item, note.at))
        value.group.add(paper)
        hotspots.push({ id: `note:${note.id}`, at: () => withOffset(note.item, note.at), reach: 2.1, paper })
      }
    }
  }

  function focus(): Hotspot | null {
    if (actions.note) return hotspots.find((h) => h.id === `note:${actions.note}`) ?? null
    if (actions.journal >= 0) return hotspots.find((h) => h.id === 'journal') ?? null
    if (actions.headphones) return hotspots.find((h) => h.id === 'console') ?? null
    camera.getWorldPosition(eye)
    camera.getWorldDirection(fwd)
    let best: Hotspot | null = null
    let score = Infinity
    for (const h of hotspots) {
      if (!actions.verb(h.id) || !allow(h.id)) continue
      delta.copy(h.at()).sub(eye)
      const d = delta.length()
      if (d > h.reach || d < 0.01) continue
      const angle = fwd.dot(delta.multiplyScalar(1 / d))
      if (angle < 0.9) continue
      const s = (1 - angle) * 8 + d * 0.05
      if (s < score) { score = s; best = h }
    }
    return best
  }

  let cues: TapeCue[] = []
  let tapeAt = 0
  let cueIndex = 0
  let selected: Hotspot | null = null
  let fuelAt = -Infinity
  let crateTarget: number | null = null
  let lidAngle = 0
  let wheelAngle = 0
  function emit(event: ActionEvent): void {
    switch (event.kind) {
      case 'pick': world.flashlight.pick(); hands.setCarried(true); break
      case 'read:open': {
        read.showNote(event.id!)
        hands.setReading(true)
        const paper = hotspots.find((h) => h.id === `note:${event.id}`)?.paper
        if (paper) paper.visible = false
        break
      }
      case 'read:close': {
        read.hide()
        hands.setReading(false)
        const paper = hotspots.find((h) => h.id === `note:${event.id}`)?.paper
        if (paper) paper.visible = true
        break
      }
      case 'journal:open': read.showJournal(0); break
      case 'journal:page': read.showJournal(event.value!); break
      case 'journal:close': read.hide(); break
      case 'console:wear': {
        const phones = inside?.furnish.moving.get('console/headphones')
        if (phones) turn(phones, 0.28)
        break
      }
      case 'console:leave': {
        const phones = inside?.furnish.moving.get('console/headphones')
        if (phones) turn(phones, 0)
        ambient.listen(0)
        break
      }
      case 'channel': {
        ambient.listen(event.value!, actions.tapePlaying && event.value === 4)
        const selector = inside?.furnish.moving.get('console/selector')
        if (selector) turn(selector, 1.2 - (event.value! - 1) * 0.48)
        const toggle = inside?.furnish.moving.get(`console/toggle-${event.value}`)
        if (toggle) turn(toggle, -0.45)
        break
      }
      case 'tape:start': {
        cues = scheduleTape(steps.snapshot(), [
          { at: 0, x: -4, z: 24, surface: 'mud', running: false },
          { at: 10, x: 0, z: 12, surface: 'mud', running: false },
          { at: 20, x: (DOOR.x0 + DOOR.x1) / 2, z: 1, surface: 'concrete', running: false },
        ])
        tapeAt = performance.now() / 1000
        cueIndex = 0
        break
      }
      case 'pull': {
        const lever = inside?.furnish.moving.get('generator/lever')
        if (lever) {
          turn(lever, -0.6)
          setTimeout(() => turn(lever, 0.6), 280)
        }
        break
      }
      case 'fuel': fuelAt = performance.now() / 1000; hands.setPouring(true); break
      case 'push': {
        const crate = inside?.furnish.placed.get('crate')?.group
        if (crate) crateTarget = (crateTarget ?? crate.position.z) + 0.4
        break
      }
      case 'open':
        if (event.id === 'wheel') {
          wheelAngle = 0.001
        }
        break
      case 'remove': {
        const tarp = inside?.furnish.placed.get('tarp')?.group
        if (tarp) tarp.visible = false
        break
      }
      case 'mode:auto': {
        const lever = inside?.furnish.moving.get('climate/lever')
        if (lever) turn(lever, -0.6)
        break
      }
    }
    onEvent(event)
  }
  function act(): void {
    const target = selected ?? focus()
    if (!target || !allow(target.id)) return
    for (const event of actions.act(target.id)) emit(event)
  }
  function update(dt: number, stride: number, moving: boolean): void {
    if (moving && actions.pose) for (const e of actions.leave()) emit(e)
    selected = focus()
    const verb = selected && actions.verb(selected.id)
    hint.textContent = verb ?? ''
    hint.classList.toggle('on', !!verb)
    status.textContent = actions.headphones ? `${actions.channel} / 6` : ''
    hands.update(stride)
    display?.update(dt, actions.channel)
    if (inside) {
      const crate = inside.furnish.placed.get('crate')?.group
      if (crate && crateTarget !== null) crate.position.z += (crateTarget - crate.position.z) * Math.min(1, dt * 5)
      const wheel = inside.furnish.moving.get('porthole/wheel')
      const lid = inside.furnish.moving.get('porthole/lid')
      if (wheelAngle > 0 && wheelAngle < Math.PI * 2) {
        wheelAngle = Math.min(Math.PI * 2, wheelAngle + dt * 5)
        if (wheel) turn(wheel, wheelAngle)
      } else if (wheelAngle >= Math.PI * 2 && lidAngle < Math.PI) {
        lidAngle = Math.min(Math.PI, lidAngle + dt * 1.5)
        if (lid) turn(lid, lidAngle)
      }
      const can = inside.furnish.placed.get('jerrycan-full')?.group
      if (can && fuelAt > 0) {
        const t = performance.now() / 1000 - fuelAt
        const home = can.userData.home as THREE.Vector3 | undefined ?? (can.userData.home = can.position.clone())
        const k = t < 0.5 ? t * 2 : t < 0.9 ? 1 : Math.max(0, 1 - (t - 0.9) * 2)
        const fill = at('generator', 'filler')
        can.position.copy(home).lerp(fill.add(new THREE.Vector3(-0.15, -0.35, 0)), k)
        can.rotation.z = -k * 0.9
        if (t >= 1.4) { fuelAt = -Infinity; can.position.copy(home); can.rotation.z = 0; hands.setPouring(false) }
      }
      for (const h of hotspots) if (h.paper) h.paper.position.copy(h.at())
    }
    if (cueIndex < cues.length) {
      const now = performance.now() / 1000 - tapeAt
      while (cueIndex < cues.length && cues[cueIndex].at <= now) {
        const cue = cues[cueIndex++]
        if (cue.kind === 'step' && cue.step) ambient.tapeStep(cue.step)
        else if (cue.kind === 'stop') {
          for (const e of actions.finishTape()) emit(e)
          ambient.listen(actions.headphones ? actions.channel : 0)
        } else ambient.tapeCue(cue.kind)
      }
    }
  }
  return {
    setInside, act, update, actions,
    restore(): void {
      if (actions.flashlight) hands.setCarried(true)
      if (!inside) return
      if (actions.wheel) {
        wheelAngle = Math.PI * 2; lidAngle = Math.PI
        const wheel = inside.furnish.moving.get('porthole/wheel')
        const lid = inside.furnish.moving.get('porthole/lid')
        if (wheel) turn(wheel, wheelAngle)
        if (lid) turn(lid, lidAngle)
      }
      if (actions.crate >= 3) {
        const crate = inside.furnish.placed.get('crate')?.group
        if (crate) {
          const home = (crate.userData.restoreHomeZ as number | undefined) ?? (crate.userData.restoreHomeZ = crate.position.z)
          crate.position.z = home + 1.2
        }
      }
      if (actions.tarp) {
        const tarp = inside.furnish.placed.get('tarp')?.group
        if (tarp) tarp.visible = false
      }
    },
    get target() { return selected?.id ?? null },
    get reading() { return actions.note !== null },
    /** Read-only positions for the local interaction tour. */
    targets: () => hotspots.map((h) => ({ id: h.id, point: h.at().toArray(), verb: allow(h.id) ? actions.verb(h.id) : null })),
  }
}
