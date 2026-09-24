import type { Mixer } from './mixer'

/** Six live microphone beds share one noise source and one analyser. */
export function createConsoleSound(ctx: AudioContext, mix: Mixer) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
  const samples = buffer.getChannelData(0)
  let seed = 6813
  for (let i = 0; i < samples.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0
    samples[i] = (seed / 0xffffffff) * 2 - 1
  }
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.loop = true
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  const gain = ctx.createGain()
  gain.gain.value = 0
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  src.connect(filter).connect(gain).connect(analyser).connect(mix.phones)
  src.start()
  const low = ctx.createOscillator()
  low.type = 'sawtooth'
  low.frequency.value = 54
  const lowGain = ctx.createGain()
  lowGain.gain.value = 0
  low.connect(lowGain).connect(analyser)
  low.start()
  const cutoffs = [0, 2600, 1300, 4300, 8000, 1100, 380]
  const levels = [0, 0.025, 0.02, 0.018, 0.014, 0.034, 0.012]
  let channel = 0
  return {
    analyser,
    set(value: number, tape = false): void {
      channel = value
      const t = ctx.currentTime
      filter.frequency.setTargetAtTime(cutoffs[value] ?? 1000, t, 0.08)
      gain.gain.setTargetAtTime(tape && value === 4 ? 0.003 : levels[value] ?? 0, t, 0.08)
      lowGain.gain.setTargetAtTime(value === 6 ? 0.018 : 0, t, 0.08)
      mix.setHeadphones(value > 0)
    },
    get channel() { return channel },
  }
}
