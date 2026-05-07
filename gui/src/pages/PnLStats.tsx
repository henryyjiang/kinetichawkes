import {
  ComposedChart, Area, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { StatCard } from '../components/StatCard'
import { thin, fmtTimeShort, fmtUsd, hourlyPnl, ND } from '../data'
import type { SimData, BacktestStats } from '../types'

const C = { pnl: '#34d399', pnlNeg: '#f87171', inv: '#a78bfa', grid: '#1e293b', text: '#64748b' }

interface Props { data: SimData; stats: BacktestStats }

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

export function PnLStats({ data, stats }: Props) {
  const pnlSeries = thin(
    data.pnl.map(p => ({
      t: fmtTimeShort(p.t),
      pnl: +(p.realized / ND).toFixed(4),
      inv: p.inventory,
    })),
    600,
  )

  const hourly = hourlyPnl(data.pnl)

  const totalPnl = stats.totalPnlUsd
  const pnlTone = totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : 'neutral'

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-200">PnL &amp; Strategy Stats</h1>
        <p className="text-xs text-slate-500 mt-0.5">MSFT · Mar 4–14 2024 · Week 1 calibration, Week 2 out-of-sample</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Total PnL" value={fmtUsd(totalPnl)} tone={pnlTone} />
        <StatCard label="Daily Sharpe" value={stats.dailySharpe.toFixed(2)}
          sub="annualised √252" tone={stats.dailySharpe > 2 ? 'pos' : stats.dailySharpe < 0 ? 'neg' : 'neutral'} />
        <StatCard label="Our Fills" value={String(stats.totalFills)}
          sub={`${stats.fillSharesBid + stats.fillSharesAsk} shrs`} />
        <StatCard label="Peak Inventory" value={`${stats.peakInventory} shrs`} />
        <StatCard label="Max Drawdown" value={fmtUsd(-stats.maxDrawdownUsd)}
          sub="mark-to-market" tone={stats.maxDrawdownUsd > 0 ? 'neg' : 'neutral'} />
        <StatCard label="Session Days" value={String(stats.sessionDays)} sub="trading days" />
      </div>

      {/* PnL + Inventory chart */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-300 mb-4">Cumulative PnL &amp; Inventory</p>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={pnlSeries} margin={{ left: 10, right: 40, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="t" tick={{ fill: C.text, fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis yAxisId="pnl" tick={{ fill: C.text, fontSize: 10 }} tickFormatter={v => `$${v.toFixed(2)}`} />
            <YAxis yAxisId="inv" orientation="right" tick={{ fill: C.text, fontSize: 10 }}
              tickFormatter={v => `${v}sh`} />
            <Tooltip content={<DarkTooltip />} />
            <Legend iconType="circle" />
            <ReferenceLine yAxisId="pnl" y={0} stroke="#475569" strokeDasharray="4 2" />
            <Area yAxisId="pnl" type="monotone" dataKey="pnl" name="PnL ($)"
              stroke={C.pnl} fill={C.pnl} fillOpacity={0.15} strokeWidth={1.5} dot={false} />
            <Line yAxisId="inv" type="stepAfter" dataKey="inv" name="Inventory (sh)"
              stroke={C.inv} strokeWidth={1.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Per-hour PnL */}
      {hourly.length > 0 && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-300 mb-4">PnL by Hour (UTC)</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={hourly} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="hour" tick={{ fill: C.text, fontSize: 10 }} />
              <YAxis tick={{ fill: C.text, fontSize: 10 }} tickFormatter={v => `$${v.toFixed(2)}`} />
              <Tooltip content={<DarkTooltip />} />
              <ReferenceLine y={0} stroke="#475569" />
              <Bar dataKey="pnl" name="PnL ($)"
                fill={C.pnl}
                // colour each bar independently
                label={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
