import { useState, useMemo } from 'react'
import { Plot3D } from '../components/Plot3D'

// Calibrated MSFT betas from configs/MSFT.json
const DEFAULT_BETAS = { b0: 4.213, b1: -4.153, b2: -2.269, b3: 1.982 }

const GRID_N = 50
const fracGrid = Array.from({ length: GRID_N }, (_, i) => i / (GRID_N - 1))          // 0..1
const logQGrid = Array.from({ length: GRID_N }, (_, i) => 1.0 + i * (8.0 / (GRID_N - 1))) // ln(Q): 1..9

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

function computeSurface(b0: number, b1: number, b2: number, b3: number) {
  return fracGrid.map(f =>
    logQGrid.map(lq => +sigmoid(b0 + b1 * f + b2 * lq + b3 * f * lq).toFixed(4))
  )
}

interface SliderProps {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void
  info: string
}

function BetaSlider({ label, value, min, max, step, onChange, info }: SliderProps) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-baseline">
        <span className="text-xs font-mono text-slate-300">{label}</span>
        <span className="text-xs font-mono text-sky-400">{value.toFixed(3)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)} className="w-full" />
      <p className="text-[10px] text-slate-600">{info}</p>
    </div>
  )
}

export function KineticSurface() {
  const [b0, setB0] = useState(DEFAULT_BETAS.b0)
  const [b1, setB1] = useState(DEFAULT_BETAS.b1)
  const [b2, setB2] = useState(DEFAULT_BETAS.b2)
  const [b3, setB3] = useState(DEFAULT_BETAS.b3)

  const z = useMemo(() => computeSurface(b0, b1, b2, b3), [b0, b1, b2, b3])

  const plotData = useMemo(() => [{
    type: 'surface',
    x: logQGrid.map(lq => +Math.exp(lq).toFixed(1)),   // actual Q values on axis
    y: fracGrid,
    z,
    colorscale: [
      [0,    '#0f172a'],
      [0.2,  '#1e3a5f'],
      [0.5,  '#0369a1'],
      [0.75, '#38bdf8'],
      [1.0,  '#f0f9ff'],
    ],
    showscale: true,
    colorbar: {
      title: { text: 'P(fill)', side: 'right', font: { color: '#94a3b8' } },
      tickfont: { color: '#94a3b8', size: 10 },
      len: 0.6,
    },
    contours: {
      z: { show: true, usecolormap: true, project: { z: true } },
    },
    hovertemplate: 'Q: %{x}<br>frac: %{y:.2f}<br>P(fill): %{z:.3f}<extra></extra>',
  }], [z])

  const plotLayout = useMemo(() => ({
    title: {
      text: 'Fill Probability Surface  ·  P(fill | frac, Q)',
      font: { color: '#cbd5e1', size: 13 },
    },
    scene: {
      xaxis: { title: { text: 'Queue depth Q (shares)', font: { color: '#94a3b8' } }, type: 'log' },
      yaxis: { title: { text: 'Queue fraction frac = q/Q', font: { color: '#94a3b8' } } },
      zaxis: { title: { text: 'P(fill)', font: { color: '#94a3b8' } }, range: [0, 1] },
      camera: { eye: { x: 1.6, y: -1.6, z: 0.8 } },
    },
    legend: { font: { color: '#94a3b8', size: 10 } },
  }), [])

  // Key P_fill values at current betas
  const keyPoints = useMemo(() => [
    { label: 'Front of queue (frac=0, Q=100)',  p: sigmoid(b0 + b1 * 0   + b2 * Math.log(100) + b3 * 0   * Math.log(100)) },
    { label: 'Mid queue    (frac=0.5, Q=100)', p: sigmoid(b0 + b1 * 0.5 + b2 * Math.log(100) + b3 * 0.5 * Math.log(100)) },
    { label: 'Back of queue (frac=0.9, Q=100)', p: sigmoid(b0 + b1 * 0.9 + b2 * Math.log(100) + b3 * 0.9 * Math.log(100)) },
    { label: 'Front of queue (frac=0, Q=1000)', p: sigmoid(b0 + b1 * 0   + b2 * Math.log(1000) + b3 * 0   * Math.log(1000)) },
    { label: 'Back of queue (frac=0.9, Q=1000)', p: sigmoid(b0 + b1 * 0.9 + b2 * Math.log(1000) + b3 * 0.9 * Math.log(1000)) },
  ], [b0, b1, b2, b3])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-200">Kinetic Fill Probability Surface</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          P(fill | q, Q) = σ(β₀ + β₁·frac + β₂·log Q + β₃·frac·log Q)  ·  MSFT fit on 2024-03-04
        </p>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* 3D surface — spans 2 cols */}
        <div className="col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-4">
          <Plot3D data={plotData} layout={plotLayout} className="h-[500px]" />
        </div>

        {/* Controls + key values */}
        <div className="space-y-5">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-5">
            <p className="text-sm font-semibold text-slate-300">Beta Parameters</p>
            <BetaSlider label="β₀ (intercept)" value={b0} min={-8} max={8} step={0.05}
              onChange={setB0} info="Baseline log-odds of filling" />
            <BetaSlider label="β₁ (frac slope)" value={b1} min={-12} max={0} step={0.05}
              onChange={setB1} info="Being further back hurts (expect < 0)" />
            <BetaSlider label="β₂ (log Q slope)" value={b2} min={-5} max={5} step={0.05}
              onChange={setB2} info="Large queues = active levels" />
            <BetaSlider label="β₃ (interaction)" value={b3} min={-3} max={5} step={0.05}
              onChange={setB3} info="Frac penalty lessens on big levels" />
            <button
              onClick={() => { setB0(DEFAULT_BETAS.b0); setB1(DEFAULT_BETAS.b1); setB2(DEFAULT_BETAS.b2); setB3(DEFAULT_BETAS.b3) }}
              className="w-full text-xs py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
            >
              Reset to MSFT calibration
            </button>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-2">
            <p className="text-sm font-semibold text-slate-300 mb-3">Key P(fill) Values</p>
            {keyPoints.map(kp => (
              <div key={kp.label} className="flex justify-between items-center">
                <span className="text-[10px] text-slate-500 leading-tight max-w-[140px]">{kp.label}</span>
                <span className={`text-sm font-bold font-mono ${kp.p > 0.3 ? 'text-emerald-400' : kp.p > 0.1 ? 'text-amber-400' : 'text-red-400'}`}>
                  {(kp.p * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
