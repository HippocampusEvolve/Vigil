/**
 * world/leaves.ts — атлас листвы, нарисованный кодом на канве.
 *
 * Восемь ячеек 256 x 256 в одной текстуре 1024 x 512: широкий лист (банан,
 * геликония), рассечённый (монстера), вайя папоротника, перо пальмы, пучок
 * травы, борода мха, клок кроны, плеть лианы. Файлов нет: всё - контуры и
 * прожилки, прорисованные при сборке мира за несколько миллисекунд.
 *
 * Лист в этом мире почти всегда силуэт в тумане, и главное в ячейке - форма
 * края. Прожилки и пятна нужны вблизи и там, где лист ловит свет лампы.
 */

import * as THREE from 'three'
import { rng } from './geom'

export const LEAF = {
  broad: 0,
  split: 1,
  fern: 2,
  palm: 3,
  grass: 4,
  moss: 5,
  crown: 6,
  vine: 7,
} as const
export type LeafKind = keyof typeof LEAF

const CELL = 256
const COLS = 4
const ROWS = 2

/** UV-рамка ячейки: [u0, v0, u1, v1]. Ось v у three идёт снизу вверх. */
export function cellUV(kind: LeafKind): [number, number, number, number] {
  const i = LEAF[kind]
  const col = i % COLS
  const row = Math.floor(i / COLS)
  const pad = 2 / (CELL * COLS)
  const u0 = col / COLS + pad
  const u1 = (col + 1) / COLS - pad
  const v1 = 1 - row / ROWS - pad * 2
  const v0 = 1 - (row + 1) / ROWS + pad * 2
  return [u0, v0, u1, v1]
}

type Ctx = CanvasRenderingContext2D

function green(r: () => number, light = 0): string {
  const h = 92 + r() * 30
  const s = 32 + r() * 22
  const l = 22 + r() * 10 + light
  return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`
}

/** Прожилки: средняя жилка и боковые, тёмной линией поверх листа. */
function veins(g: Ctx, len: number, width: number, count: number): void {
  g.strokeStyle = 'rgba(20, 35, 15, 0.55)'
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(0, 0)
  g.lineTo(0, -len)
  g.stroke()
  g.lineWidth = 1
  for (let i = 1; i < count; i++) {
    const y = -(len * i) / count
    const w = width * Math.sin((Math.PI * i) / count)
    g.beginPath()
    g.moveTo(0, y)
    g.quadraticCurveTo(w * 0.5, y - 6, w * 0.95, y - 14)
    g.moveTo(0, y)
    g.quadraticCurveTo(-w * 0.5, y - 6, -w * 0.95, y - 14)
    g.stroke()
  }
}

function broad(g: Ctx, r: () => number): void {
  const len = 236
  const w = 58
  g.translate(128, 248)
  g.fillStyle = green(r)
  g.beginPath()
  g.moveTo(0, 0)
  g.bezierCurveTo(w * 1.1, -len * 0.2, w * 1.05, -len * 0.75, 0, -len)
  g.bezierCurveTo(-w * 1.05, -len * 0.75, -w * 1.1, -len * 0.2, 0, 0)
  g.fill()
  veins(g, len, w, 16)
  // Лист банана рвётся ветром и дождём по боковым жилкам.
  g.globalCompositeOperation = 'destination-out'
  g.lineWidth = 3
  for (let i = 0; i < 7; i++) {
    const y = -len * (0.2 + r() * 0.7)
    const side = r() < 0.5 ? -1 : 1
    g.beginPath()
    g.moveTo(side * w * 1.2, y - 18)
    g.lineTo(side * w * (0.15 + r() * 0.4), y)
    g.stroke()
  }
  g.globalCompositeOperation = 'source-over'
}

function split(g: Ctx, r: () => number): void {
  g.translate(128, 240)
  g.fillStyle = green(r, 2)
  g.beginPath()
  g.moveTo(0, 0)
  g.bezierCurveTo(118, -20, 120, -170, 0, -226)
  g.bezierCurveTo(-120, -170, -118, -20, 0, 0)
  g.fill()
  veins(g, 220, 100, 9)
  g.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i - 2.5) * 0.42
    g.lineWidth = 6 + r() * 4
    g.beginPath()
    g.moveTo(Math.cos(a) * 130, -110 + Math.sin(a) * 130)
    g.lineTo(Math.cos(a) * 55, -110 + Math.sin(a) * 55)
    g.stroke()
    g.beginPath()
    g.ellipse(Math.cos(a) * 38, -110 + Math.sin(a) * 38 - 20, 5, 9, a, 0, Math.PI * 2)
    g.fill()
  }
  g.globalCompositeOperation = 'source-over'
}

function fern(g: Ctx, r: () => number): void {
  g.translate(128, 252)
  const len = 244
  g.strokeStyle = 'hsl(90, 25%, 20%)'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(0, 0)
  g.quadraticCurveTo(6, -len / 2, 0, -len)
  g.stroke()
  for (let i = 2; i < 30; i++) {
    const t = i / 30
    const y = -len * t
    const pl = 70 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.3)
    g.fillStyle = green(r, -2)
    for (const side of [-1, 1]) {
      g.beginPath()
      g.moveTo(0, y)
      g.quadraticCurveTo(side * pl * 0.5, y - 10, side * pl, y - 16 - pl * 0.25)
      g.quadraticCurveTo(side * pl * 0.5, y + 2, 0, y + 5)
      g.fill()
    }
  }
}

function palm(g: Ctx, r: () => number): void {
  g.translate(128, 254)
  const len = 248
  g.strokeStyle = 'hsl(70, 25%, 22%)'
  g.lineWidth = 4
  g.beginPath()
  g.moveTo(0, 0)
  g.lineTo(0, -len)
  g.stroke()
  g.lineCap = 'round'
  for (let i = 1; i < 34; i++) {
    const t = i / 34
    const y = -len * t
    const l = 118 * Math.sin(Math.PI * Math.min(1, 0.25 + t * 0.85))
    g.strokeStyle = green(r, 1)
    g.lineWidth = 4 + 3 * (1 - t)
    for (const side of [-1, 1]) {
      g.beginPath()
      g.moveTo(0, y)
      g.quadraticCurveTo(side * l * 0.6, y - 20, side * l, y + 10 + r() * 16)
      g.stroke()
    }
  }
}

function grass(g: Ctx, r: () => number): void {
  g.translate(128, 256)
  for (let i = 0; i < 16; i++) {
    const a = (r() - 0.5) * 1.3
    const len = 150 + r() * 100
    const w = 5 + r() * 5
    g.fillStyle = green(r, 4)
    g.beginPath()
    g.moveTo(-w, 0)
    g.quadraticCurveTo(Math.sin(a) * len * 0.5 - w, -len * 0.55, Math.sin(a) * len, -len * Math.cos(a * 0.6))
    g.quadraticCurveTo(Math.sin(a) * len * 0.5 + w, -len * 0.55, w, 0)
    g.fill()
  }
}

function moss(g: Ctx, r: () => number): void {
  g.translate(0, 0)
  g.lineCap = 'round'
  for (let i = 0; i < 70; i++) {
    const x = 20 + r() * 216
    const len = 90 + r() * 160
    g.strokeStyle = `hsl(${(75 + r() * 25).toFixed(0)}, 22%, ${(24 + r() * 10).toFixed(0)}%)`
    g.lineWidth = 1.5 + r() * 2.5
    g.beginPath()
    g.moveTo(x, 0)
    let px = x
    for (let y = 0; y < len; y += 12) {
      px += (r() - 0.5) * 7
      g.lineTo(px, y)
    }
    g.stroke()
  }
}

function crown(g: Ctx, r: () => number): void {
  g.translate(128, 128)
  for (let i = 0; i < 90; i++) {
    const a = r() * Math.PI * 2
    const d = Math.sqrt(r()) * 100
    g.fillStyle = green(r, -2)
    g.save()
    g.translate(Math.cos(a) * d, Math.sin(a) * d)
    g.rotate(r() * Math.PI * 2)
    g.beginPath()
    g.ellipse(0, 0, 8 + r() * 10, 18 + r() * 14, 0, 0, Math.PI * 2)
    g.fill()
    g.restore()
  }
}

function vine(g: Ctx, r: () => number): void {
  g.translate(128, 0)
  g.strokeStyle = 'hsl(60, 20%, 20%)'
  g.lineWidth = 4
  g.beginPath()
  g.moveTo(0, 0)
  for (let y = 0; y <= 256; y += 16) g.lineTo(Math.sin(y * 0.05) * 14, y)
  g.stroke()
  for (let y = 10; y < 250; y += 22) {
    const x = Math.sin(y * 0.05) * 14
    const side = (y / 22) % 2 < 1 ? 1 : -1
    g.fillStyle = green(r, 1)
    g.save()
    g.translate(x, y)
    g.rotate(side * (0.6 + r() * 0.5))
    g.beginPath()
    g.moveTo(0, 0)
    g.bezierCurveTo(side * 26, 4, side * 30, 30, 0, 38)
    g.bezierCurveTo(-side * 8, 26, -side * 4, 8, 0, 0)
    g.fill()
    g.restore()
  }
}

const PAINTERS: Record<LeafKind, (g: Ctx, r: () => number) => void> = {
  broad,
  split,
  fern,
  palm,
  grass,
  moss,
  crown,
  vine,
}

/** Нарисовать атлас. Зовётся один раз при сборке мира, только в браузере. */
export function leafAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = CELL * COLS
  canvas.height = CELL * ROWS
  const g = canvas.getContext('2d')!
  const r = rng(77)
  for (const kind of Object.keys(LEAF) as LeafKind[]) {
    const i = LEAF[kind]
    g.save()
    g.beginPath()
    g.rect((i % COLS) * CELL, Math.floor(i / COLS) * CELL, CELL, CELL)
    g.clip()
    g.translate((i % COLS) * CELL, Math.floor(i / COLS) * CELL)
    PAINTERS[kind](g, r)
    g.restore()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  return tex
}
