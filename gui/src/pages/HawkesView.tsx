import { useMemo } from 'react'
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Legend,
} from 'recharts'
import { Plot3D } from '../components/Plot3D'
import { thin, fmtTimeShort } from '../data'
import type { SimData } from '../types'

const C = { buy: '#38bdf8', sell: '#fb7185', cancel: '#a78bfa',
            imb: '#fbbf24', grid: '#1e293b', text: '#64748b' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DarkTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs font-mono shadow-xl">
      <p className="text-slate-400 mb-2">{label}</p>
      {payload.map((p: {name: string; value: number; color: string}) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(4) : p.value}
        </p>
      ))}
    </div>
  )
}

interface Props { data: SimData }

export function HawkesView({ data }: Props) {
  const series = useMemo(() =>
    thin(data.hawkes.map(h => ({
      t:         fmtTimeShort(h.t),
      lam_buy:   +h.lam_buy.toFixed(4),
      lam_sell:  +h.lam_sell.toFixed(4),
      lam_cancel: +Math.min(h.lam_cancel, 500).toFixed(4),  // cap for display
      imbalance: +h.imbalance.toFixed(4),
    })), 800),
  [data.hawkes])

  // 3-D phase-space trajectory: (λ_buy, λ_sell, λ_cancel)
  // Downsample heavily for Plotly performance
  const phase = useMemo(() => {
    const s = thin(data.hawkes, 1500)
    return {
      x: s.map(h => h.lam_buy),
      y: s.map(h => h.lam_sell),
      z: s.map(h => Math.min(h.lam_cancel, 200)),
      color: s.map(h => h.imbalance),
    }
  }, [data.hawkes])

  // Steady-state point from MSFT calibration
  const SS = { buy: 0.995, sell: 6.053, cancel: 7.901 }

  const plotData = useMemo(() => [
    {
      type: 'scatter3d',
      mode: 'lines',
      x: phase.x, y: phase.y, z: phase.z,
      line: {
        color: phase.color,
        colorscale: [
          [0, '#fb7185'], [0.5, '#fbbf24'], [1, '#38bdf8'],
        ],
        width: 2,
        colorbar: {
          title: 'Imbalance',
          tickfont: { color: '#94a3b8', size: 10 },
          len: 0.5,
        },
      },
      name: 'Phase trajectory',
      hovertemplate: 'λ_buy: %{x:.2f}<br>λ_sell: %{y:.2f}<br>λ_cancel: %{z:.2f}<extra></extra>',
    },
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [SS.buy], y: [SS.sell], z: [SS.cancel],
      marker: { size: 8, color: '#34d399', symbol: 'diamond' },
      name: 'Steady state E[λ]',
      hovertemplate: 'Steady state<extra></extra>',
    },
  ], [phase])

  const plotLayout = useMemo(() => ({
    title: { text: 'Phase Space  (λ_buy, λ_sell, λ_cancel)  · coloured by buy imbalance', font: { color: '#cbd5e1', size: 13 } },
    scene: {
      xaxis: { title: { text: 'λ_buy (ev/s)', font: { color: '#94a3b8' } } },
      yaxis: { title: { text: 'λ_sell (ev/s)', font: { color: '#94a3b8' } } },
      zaxis: { title: { text: 'λ_cancel (ev/s)', font: { color: '#94a3b8' } } },
    },
    legend: { font: { color: '#94a3b8', size: 10 } },
  }), [])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-200">Hawkes Intensity</h1>
        <p className="text-xs text-slate-500 mt-0.5">Recursive O(1) updates · calibrated on Week 1 (Mar 4–8 2024)</p>
      </div>

      {/* 2D intensities */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-300 mb-1">λ(t) — Market Order &amp; Cancel Intensity</p>
        <p className="text-xs text-slate-500 mb-4">λ_cancel capped at 500 ev/s for display</p>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={series} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="t" tick={{ fill: C.text, fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fill: C.text, fontSize: 10 }} />
            <Tooltip content={<DarkTooltip />} />
            <Legend iconType="circle" />
            <Line type="monotone" dataKey="lam_buy"    name="λ_buy (ev/s)"    stroke={C.buy}    strokeWidth={1.5} dot={false} />
            <Line type="monotone" dataKey="lam_sell"   name="λ_sell (ev/s)"   stroke={C.sell}   strokeWidth={1.5} dot={false} />
            <Line type="monotone" dataKey="lam_cancel" name="λ_cancel (ev/s)" stroke={C.cancel} strokeWidth={1}   dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Flow imbalance */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-300 mb-1">Buy Pressure  ·  λ_buy / (λ_buy + λ_sell)</p>
        <p className="text-xs text-slate-500 mb-4">&gt;0.6 = strong directional buy flow</p>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={series} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="t" tick={{ fill: C.text, fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fill: C.text, fontSize: 10 }} domain={[0, 1]} />
            <Tooltip content={<DarkTooltip />} />
            <Area type="monotone" dataKey="imbalance" name="Buy imbalance"
              stroke={C.imb} fill={C.imb} fillOpacity={0.2} strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* 3D phase space */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-300 mb-1">3D Phase Space Trajectory</p>
        <p className="text-xs text-slate-500 mb-3">
          Coloured by buy imbalance (blue = buy dominant, red = sell dominant) ·
          green ◆ = calibrated steady-state point
        </p>
        <Plot3D data={plotData} layout={plotLayout} className="h-[480px]" />
      </div>
    </div>
  )
}
