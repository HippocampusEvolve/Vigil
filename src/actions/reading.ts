type Texts = {
  notes?: Record<string, { lines: string[]; decay: number }>
  journal?: string[][][]
}

/** Equivalent perspective projection, in CSS pixels, for the hand-held paper. */
export function projectedHeight(viewport: number, fovDeg: number, distance: number, metres: number): number {
  return viewport * metres / (2 * distance * Math.tan(fovDeg * Math.PI / 360))
}
export function projectedGlyph(viewport: number, cardCssHeight: number, glyphOnCard: number): number {
  const paperMetres = 0.43
  const distance = 0.45
  return projectedHeight(viewport, 70, distance, glyphOnCard * paperMetres / cardCssHeight)
}

export function createReading(texts: Texts | undefined, action: () => void, journalLines: () => string[] = () => [], journalDay?: number) {
  const card = document.createElement('div')
  card.id = 'read-card'
  card.hidden = true
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Чтение')
  const canvas = document.createElement('canvas')
  card.append(canvas)
  document.body.append(card)
  const style = document.createElement('style')
  style.textContent = `
    #read-card { position:fixed; z-index:6; left:50%; top:50%; transform:translate(-50%,-50%) rotate(-1deg);
      width:min(84vw,420px); height:min(68vh,530px); max-height:calc(100dvh - 112px);
      box-shadow:0 18px 64px #000b, 0 0 20px #d9b87620; background:#c8bb96;
      touch-action:none; cursor:grab; }
    #read-card[hidden] { display:none }
    #read-card canvas { width:100%; height:100%; display:block }
    @media (max-width:420px) { #read-card { width:84vw; height:68vh } }
  `
  document.head.append(style)
  let title = ''
  let lines: string[] = []
  let decay = 0
  let scroll = 0
  let contentHeight = 0
  let visibleBottom = 0
  let dragging = false
  let fromY = 0
  let moved = 0

  function draw(): void {
    const w = card.clientWidth
    const h = card.clientHeight
    if (!w || !h) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const c = canvas.getContext('2d')!
    c.scale(dpr, dpr)
    c.fillStyle = '#c9ba95'
    c.fillRect(0, 0, w, h)
    c.fillStyle = '#d6c8a5'
    c.fillRect(8, 7, w - 16, h - 14)
    c.strokeStyle = '#70694f44'
    c.strokeRect(15.5, 14.5, w - 31, h - 29)
    c.save()
    c.beginPath()
    visibleBottom = title ? h - 22 : h - 88
    c.rect(24, 22, w - 48, visibleBottom - 22)
    c.clip()
    c.translate(0, -scroll)
    const font = Math.max(32, Math.min(36, w / 9.5))
    c.font = `italic ${font}px Georgia, "Times New Roman", serif`
    // The measured lowercase glyph, rather than font size, is the acceptance value.
    const glyph = c.measureText('н').actualBoundingBoxAscent
    card.dataset.glyphPx = glyph.toFixed(2)
    card.dataset.projectedGlyphPx = projectedGlyph(innerHeight, h, glyph).toFixed(2)
    c.fillStyle = '#343052'
    c.globalAlpha = 1 - decay * 0.28
    c.textBaseline = 'alphabetic'
    const lineH = font * 1.34
    let y = 34 + font
    let lineIndex = 0
    const write = (row: string): void => {
      c.save()
      c.translate(29 + Math.sin(lineIndex * 1.7) * decay * 1.1,
        y + Math.sin(lineIndex * 2.3) * decay * 0.7)
      c.transform(1, 0, -decay * 0.11, 1, 0, 0)
      c.fillText(row, 0, 0)
      c.restore()
      lineIndex++
    }
    for (const paragraph of [title, ...lines]) {
      if (!paragraph) { y += lineH * 0.45; continue }
      let row = ''
      for (const word of paragraph.split(/\s+/)) {
        const next = row ? `${row} ${word}` : word
        if (row && c.measureText(next).width > w - 58) {
          write(row)
          y += lineH
          row = word
        } else row = next
      }
      if (row) { write(row); y += lineH }
      y += lineH * 0.2
    }
    contentHeight = y + 8
    const maxScroll = Math.max(0, contentHeight - visibleBottom)
    card.dataset.scrollPx = scroll.toFixed(1)
    card.dataset.maxScrollPx = maxScroll.toFixed(1)
    c.restore()
    if (!title) {
      // A hand on the near edge of the paper: cloth cuff, old bandage and stencil.
      c.fillStyle = '#505343'
      c.beginPath(); c.moveTo(0, h - 9); c.lineTo(0, h - 74); c.lineTo(42, h - 55); c.lineTo(80, h); c.closePath(); c.fill()
      c.fillStyle = '#9b8068'
      c.beginPath(); c.ellipse(77, h - 28, 18, 28, -0.55, 0, Math.PI * 2); c.fill()
      c.fillStyle = '#b7a98c'
      for (let i = 0; i < 3; i++) { c.save(); c.translate(66 + i * 8, h - 37 + i * 2); c.rotate(-0.5); c.fillRect(-4, -20, 8, 39); c.restore() }
      c.fillStyle = '#684c41'
      c.fillRect(72, h - 33, 7, 6)
      c.fillStyle = '#d5d4c1'
      c.font = 'bold 18px system-ui'
      c.fillText('16', 16, h - 22)
    }
    if (scroll < maxScroll - 4) {
      c.fillStyle = '#34305299'
      c.font = '15px system-ui'
      c.textAlign = 'right'
      c.fillText('↓', w - 20, h - 17)
    }
  }

  function showNote(id: string): void {
    const note = texts?.notes?.[id]
    if (!note) return
    title = ''
    lines = note.lines
    decay = Math.max(0, Math.min(1, note.decay))
    scroll = 0
    card.hidden = false
    card.setAttribute('aria-label', `Записка ${id}`)
    draw()
  }
  function showJournal(page: number): void {
    const spread = texts?.journal?.[page]
    if (!spread) return
    title = `${page + 1} / ${texts?.journal?.length ?? 6}`
    lines = [...spread.flatMap((block, i) => i ? ['', ...block] : block).map((line) => page === 0 && journalDay ? line.replace(/\bN\b/g, String(journalDay)) : line), ...(page === 0 ? journalLines() : [])]
    decay = Math.min(1, page / 5)
    scroll = 0
    card.hidden = false
    card.setAttribute('aria-label', `Журнал, разворот ${page + 1}`)
    draw()
  }
  card.addEventListener('wheel', (e) => {
    e.preventDefault()
    scroll = Math.max(0, Math.min(Math.max(0, contentHeight - visibleBottom), scroll + e.deltaY))
    draw()
  }, { passive: false })
  card.addEventListener('pointerdown', (e) => {
    dragging = true
    fromY = e.clientY
    moved = 0
    if (e.isTrusted) card.setPointerCapture(e.pointerId)
  })
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dy = e.clientY - fromY
    moved += Math.abs(dy)
    scroll = Math.max(0, Math.min(Math.max(0, contentHeight - visibleBottom), scroll - dy))
    fromY = e.clientY
    draw()
  })
  card.addEventListener('pointerup', () => { dragging = false; if (moved < 7) action() })
  addEventListener('resize', () => { if (!card.hidden) draw() })
  return {
    showNote,
    showJournal,
    hide: () => { card.hidden = true },
    get visible() { return !card.hidden },
    element: card,
  }
}
