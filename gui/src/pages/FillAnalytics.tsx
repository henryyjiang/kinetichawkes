import { useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Cell, Legend,
} from 'recharts'
import { StatCard } from '../components/StatCard'
import { fmtTimeFull, fmtUsd, ND } from '../data'
import type { SimData } from '../types'

const C = { bid: '#38bdf8', ask: '#fb7185', pnl: '#34d399', grid: '#1e293b', text: '#64748b' }

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

export function FillAnalytics({ data }: Props) {
  const { fills } = data

  const bidFills = fills.filter(f => f.side === 'bid')
  const askFills = fills.filter(f => f.side === 'ask')
  const totalShrs = fills.reduce((a, f) => a + f.size, 0)
  const lastPnl = fills.at(-1)?.pnl_delta ?? 0

  // Cumulative fill size over time
  const cumFills = useMemo(() => {
    let cumBid = 0, cumAsk = 0
    return fills.map(f => {
      if (f.side === 'bid') cumBid += f.size
      else                  cumAsk += f.size
      return { t: fmtTimeFull(f.t), cumBid, cumAsk, total: cumBid + cumAsk }
    })
  }, [fills])

  // PnL delta per fill (incremental)
  const fillPnlSeries = useMemo(() =>
    fills.map((f, i) => {
      const prev = i > 0 ? fills[i - 1].pnl_delta : 0
      return {
        t: fmtTimeFull(f.t),
        side: f.side,
        price: +(f.price / ND).toFixed(2),
        size: f.size,
        pnl: +((f.pnl_delta - prev) / ND).toFixed(4),
        cumPnl: +(f.pnl_delta / ND).toFixed(4),
      }
    }),
  [fills])

  // Side breakdown for bar chart
  const sideBreakdown = [
    { side: 'Bid (bought)', count: bidFills.length, shares: bidFills.reduce((a, f) => a + f.size, 0) },
    { side: 'Ask (sold)',   count: askFills.length, shares: askFills.reduce((a, f) => a + f.size, 0) },
  ]

  if (fills.length === 0) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-slate-200">Fill Analytics</h1>
          <p className="text-xs text-slate-500 mt-0.5">Our passive fills from the backtest</p>
        </div>
        <div className="flex items-center justify-center h-64 bg-slate-800 border border-slate-700 rounded-xl">
          <div className="text-center">
            <p className="text-4xl mb-3">🎣</p>
            <p className="text-slate-400 font-medium">No fills recorded in this run</p>
            <p className="text-slate-600 text-sm mt-1">
              The strategy didn't accumulate enough queue priority to fill in this replay.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-200">Fill Analytics</h1>
        <p className="text-xs text-slate-500 mt-0.5">Our passive fills — FIFO-matched against the ITCH replay</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Fills" value={String(fills.length)} sub={`${totalShrs} shares`} />
        <StatCard label="Bid Fills"   value={String(bidFills.length)} sub={`${bidFills.reduce((a,f)=>a+f.size,0)} sh bought`} />
        <StatCard label="Ask Fills"   value={String(askFills.length)} sub={`${askFills.reduce((a,f)=>a+f.size,0)} sh sold`} />
        <StatCard label="PnL from Fills" value={fmtUsd(lastPnl / ND)}
          tone={lastPnl > 0 ? 'pos' : lastPnl < 0 ? 'neg' : 'neutral'} />
      </div>

      {/* Cumulative filled shares */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-300 mb-4">Cumulative Filled Shares</p>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={cumFills} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="t" tick={{ fill: C.text, fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fill: C.text, fontSize: 10 }} />
            <Tooltip content={<DarkTooltip />} />
            <Legend iconType="circle" />
            <Line type="stepAfter" dataKey="cumBid"  name="Bid (bought) sh" stroke={C.bid}  strokeWidth={2} dot={{ r: 3, fill: C.bid }} />
            <Line type="stepAfter" dataKey="cumAsk"  name="Ask (sold) sh"   stroke={C.ask}  strokeWidth={2} dot={{ r: 3, fill: C.ask }} />
            <Line type="stepAfter" dataKey="total"   name="Total sh"        stroke={C.pnl}  strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Cumulative PnL from fills */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-300 mb-4">Cumulative PnL from Fills ($)</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={fillPnlSeries} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="t" tick={{ fill: C.text, fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: C.text, fontSize: 10 }} tickFormatter={v => `$${v}`} />
              <Tooltip content={<DarkTooltip />} />
              <Line type="stepAfter" dataKey="cumPnl" name="PnL ($)" stroke={C.pnl} strokeWidth={2}
                dot={{ r: 4, fill: C.pnl }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Side breakdown bar */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-300 mb-4">Fill Breakdown by Side</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={sideBreakdown} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="side" tick={{ fill: C.text, fontSize: 10 }} />
              <YAxis tick={{ fill: C.text, fontSize: 10 }} />
              <Tooltip content={<DarkTooltip />} />
              <Legend iconType="circle" />
              <Bar dataKey="shares" name="Shares" radius={[4,4,0,0]}>
                {sideBreakdown.map((_, i) => (
                  <Cell key={i} fill={i === 0 ? C.bid : C.ask} />
                ))}
              </Bar>
              <Bar dataKey="count" name="Fill count" radius={[4,4,0,0]} opacity={0.5}>
                {sideBreakdown.map((_, i) => (
                  <Cell key={i} fill={i === 0 ? C.bid : C.ask} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Fill table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-300 mb-3">Fill Log</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-slate-500 border-b border-slate-700">
                <th className="text-left pb-2 pr-4">Time (UTC)</th>
                <th className="text-left pb-2 pr-4">Side</th>
                <th className="text-right pb-2 pr-4">Price</th>
                <th className="text-right pb-2 pr-4">Size</th>
                <th className="text-right pb-2">Cumulative PnL</th>
              </tr>
            </thead>
            <tbody>
              {fillPnlSeries.map((f, i) => (
                <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-700/30">
                  <td className="py-1.5 pr-4 text-slate-400">{f.t}</td>
                  <td className="py-1.5 pr-4" style={{ color: f.side === 'bid' ? C.bid : C.ask }}>
                    {f.side === 'bid' ? '↑ bid' : '↓ ask'}
                  </td>
                  <td className="py-1.5 pr-4 text-right text-slate-300">${f.price}</td>
                  <td className="py-1.5 pr-4 text-right text-slate-300">{f.size} sh</td>
                  <td className={`py-1.5 text-right font-bold ${f.cumPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmtUsd(f.cumPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
