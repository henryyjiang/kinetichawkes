import { useEffect, useRef } from 'react'
import type { HawkesEvent } from '../types'

// ── Grid constants ────────────────────────────────────────────────────────────
const NX     = 55    // surface x-resolution
const NY     = 20    // surface y-resolution
const WINDOW = 28    // rolling event window

const xVals = Array.from({ length: NX }, (_, i) => i / (NX - 1))  // 0..1
const yVals = Array.from({ length: NY }, (_, i) => i / (NY - 1))  // 0..1

// Normalized y-positions for the three Hawkes processes
const Y_POS = [0.1, 0.5, 0.9] as const   // buy, sell, cancel

// Rough max lambda values for amplitude normalisation
const LAM_MAX = [15, 80, 300] as const

// ── Spike dynamics ────────────────────────────────────────────────────────────
const SIGMA0   = 0.016   // initial spatial sigma (grid fraction)
const D_SIGMA  = 0.0048  // sigma growth per frame
const DECAY    = 0.925   // per-frame amplitude multiplier
const MAX_AGE  = 72      // frames before removal (~2.4s @ 30fps)

// ── Types ─────────────────────────────────────────────────────────────────────
interface Spike {
  x: number      // 0..1 in rolling window
  y: number      // Y_POS[type]
  amp0: number   // normalised peak amplitude
  age: number    // frames elapsed
}

interface CompState {
  spikes:     Spike[]
  evtIdx:     number    // index into events[] we've consumed
  absIdx:     number    // global event counter (drives rolling window)
  playTick:   number    // frame counter for playback pacing
  inited:     boolean
}

// ── Surface computation ───────────────────────────────────────────────────────
function computeZ(spikes: Spike[]): number[][] {
  return yVals.map(y =>
    xVals.map(x => {
      let z = 0
      for (const s of spikes) {
        const sig = SIGMA0 + s.age * D_SIGMA
        const r2  = ((x - s.x) ** 2 + (y - s.y) ** 2) / (sig * sig)
        if (r2 > 18) continue                    // skip negligible contributions
        z += s.amp0 * Math.pow(DECAY, s.age) * Math.exp(-r2 / 2)
      }
      return z
    })
  )
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Props {
  events:    HawkesEvent[]
  streaming: boolean        // true = new events are live; false = playback mode
}

export function HawkesSpike3D({ events, streaming }: Props) {
  const divRef    = useRef<HTMLDivElement>(null)
  const stateRef  = useRef<CompState>({
    spikes: [], evtIdx: 0, absIdx: 0, playTick: 0, inited: false,
  })
  const eventsRef   = useRef(events)
  const streamingRef = useRef(streaming)
  const rafRef      = useRef(0)

  // Keep refs current without re-triggering the animation loop effect
  eventsRef.current   = events
  streamingRef.current = streaming

  // ── Single animation loop, mounted once ──────────────────────────────────
  useEffect(() => {
    if (!divRef.current) return
    const el    = divRef.current
    const state = stateRef.current
    let alive   = true

    import('plotly.js-dist-min').then((mod: Record<string, unknown>) => {
      if (!alive) return
      const Plotly = (mod.default ?? mod) as {
        react:   (el: HTMLElement, data: unknown[], layout: unknown, cfg?: unknown) => void
        restyle: (el: HTMLElement, update: unknown, traces: number[]) => void
        purge:   (el: HTMLElement) => void
      }

      const z0 = yVals.map(() => xVals.map(() => 0))

      Plotly.react(el, [{
        type: 'surface',
        x: xVals, y: yVals, z: z0,
        colorscale: [
          [0,    '#050d05'],
          [0.03, '#0a1e0a'],
          [0.10, '#00aa44'],   // green — fully decayed / low
          [0.38, '#ffaa00'],   // orange
          [0.70, '#ff4400'],   // red-orange
          [1.0,  '#ff0000'],   // bright red — fresh spike peak
        ],
        cmin: 0, cmax: 1.1,
        showscale: false,
        hoverinfo: 'none',
        lighting:      { ambient: 0.9, diffuse: 0.4, roughness: 0.6, specular: 0.02 },
        lightposition: { x: 100, y: 200, z: 600 },
        contours:      { z: { show: false } },
      }], {
        paper_bgcolor: '#0d0d0d',
        plot_bgcolor:  '#0d0d0d',
        margin: { l: 0, r: 0, t: 0, b: 0 },
        scene: {
          bgcolor: '#0d0d0d',
          aspectratio: { x: 2.2, y: 1, z: 0.75 },
          camera: { eye: { x: -1.5, y: -2.2, z: 1.3 } },
          xaxis: {
            title: '', showticklabels: false,
            showgrid: false, zeroline: false,
            backgroundcolor: '#0d0d0d', showspikes: false,
          },
          yaxis: {
            tickvals: [0.1, 0.5, 0.9],
            ticktext: ['buy λ', 'sell λ', 'cancel λ'],
            tickfont: { color: '#555', size: 9, family: 'Roboto' },
            showgrid: false, zeroline: false,
            backgroundcolor: '#0d0d0d', showspikes: false,
            title: '',
          },
          zaxis: {
            title: '', range: [0, 1.2],
            showticklabels: false, showgrid: false,
            zeroline: false, backgroundcolor: '#0d0d0d', showspikes: false,
          },
        },
      }, { responsive: true, displayModeBar: false })

      state.inited = true

      // ── RAF loop ────────────────────────────────────────────────────────
      const TARGET_MS      = 1000 / 30
      const FRAMES_PER_EVT = 6     // playback: advance one event every 6 frames ≈ 5 ev/s
      let lastT = 0

      function addEvt(ev: HawkesEvent) {
        const s = stateRef.current
        // x-position: newest event occupies the right edge, older events shift left
        const xPos = ((s.absIdx % WINDOW) / (WINDOW - 1))

        ;([0, 1, 2] as const).forEach(type => {
          const lam = [ev.lam_buy, ev.lam_sell, ev.lam_cancel][type]
          const amp = Math.min(1, lam / LAM_MAX[type])
          if (amp < 0.01) return
          // Replace any prior spike sitting at this same grid slot
          s.spikes = s.spikes.filter(
            sp => !(Math.abs(sp.x - xPos) < 1e-4 && Math.abs(sp.y - Y_POS[type]) < 1e-4)
          )
          s.spikes.push({ x: xPos, y: Y_POS[type], amp0: amp, age: 0 })
        })
        s.absIdx++
      }

      function tick(now: number) {
        if (!alive) return
        rafRef.current = requestAnimationFrame(tick)
        if (now - lastT < TARGET_MS) return
        lastT = now

        const s  = stateRef.current
        const ev = eventsRef.current
        const st = streamingRef.current

        // Playback: feed one event every FRAMES_PER_EVT frames
        if (!st && ev.length > 0) {
          s.playTick++
          if (s.playTick >= FRAMES_PER_EVT) {
            s.playTick = 0
            if (s.evtIdx < ev.length) {
              addEvt(ev[s.evtIdx])
              s.evtIdx++
            } else {
              // Loop back to beginning
              s.evtIdx = 0
              s.absIdx = 0
              s.spikes = []
            }
          }
        }

        // Streaming: consume any new events that arrived
        if (st) {
          while (s.evtIdx < ev.length) {
            addEvt(ev[s.evtIdx])
            s.evtIdx++
          }
        }

        // Age spikes and prune dead ones
        s.spikes = s.spikes
          .map(sp => ({ ...sp, age: sp.age + 1 }))
          .filter(sp => sp.age < MAX_AGE && sp.amp0 * Math.pow(DECAY, sp.age) > 0.004)

        Plotly.restyle(el, { z: [computeZ(s.spikes)] }, [0])
      }

      rafRef.current = requestAnimationFrame(tick)
    })

    return () => {
      alive = false
      cancelAnimationFrame(rafRef.current)
      import('plotly.js-dist-min').then((mod: Record<string, unknown>) => {
        const Plotly = (mod.default ?? mod) as { purge: (el: HTMLElement) => void }
        if (el) Plotly.purge(el)
      })
    }
  }, []) // mount once only

  // Reset playback state when switching from streaming → playback
  useEffect(() => {
    if (!streaming) {
      const s = stateRef.current
      s.evtIdx = 0
      s.absIdx = 0
      s.spikes = []
      s.playTick = 0
    }
  }, [streaming])

  return <div ref={divRef} style={{ width: '100%', height: '100%' }} />
}
