import { useState, useMemo } from 'react'
import {
  ComposedChart, Line, Area, XAxis, YAxis,
  Tooltip, CartesianGrid, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { thin, fmtTimeShort, fmtTimeFull, ND } from '../data'
import type { SimData } from '../types'

const C = { mid: '#94a3b8', spread: '#38bdf8', bid: '#38bdf8', ask: '#fb7185',
            bidQty: '#38bdf8', askQty: '#fb7185', grid: '#1e293b', text: '#64748b' }

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

export function BookReplay({ data }: Props) {
  const [idx, setIdx] = useState(0)

  const snapshots = useMemo(() =>
    data.book.map((b, i) => {
      // find most recent quote at or before this book event
      const qt = data.quotes.filter(q => q.t <= b.t).at(-1)
      return {
        i, t: b.t,
        mid:    b.mid    / ND,
        spread: b.spread / ND,
        bid_qty: b.bid_qty,
        ask_qty: b.ask_qty,
        our_bid: qt?.bid ? qt.bid / ND : null,
        our_ask: qt?.ask ? qt.ask / ND : null,
      }
    }),
  [data])

  const cur = snapshots[idx] ?? snapshots[0]

  const chartData = useMemo(() => thin(
    snapshots.map(s => ({
      t: fmtTimeShort(s.t),
      mid:     +s.mid.toFixed(2),
      spread:  +(s.spread * 100).toFixed(4),   // in cents for readability
      bid_qty: s.bid_qty,
      ask_qty: -s.ask_qty,                     // negative so stacked view is symmetric
      our_bid: s.our_bid ? +s.our_bid.toFixed(2) : null,
      our_ask: s.our_ask ? +s.our_ask.toFixed(2) : null,
    })),
    600,
  ), [snapshots])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-200">Order Book</h1>
        <p className="text-xs text-slate-500 mt-0.5">Top-of-book snapshots every 10 000 session events</p>
      </div>

      {/* Scrubber + current snapshot */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-4">
          <span className="text-xs text-slate-500 font-mono w-36">{fmtTimeFull(cur.t)}</span>
          <input type="range" min={0} max={snapshots.length - 1} value={idx}
            onChange={e => setIdx(+e.target.value)}
            className="flex-1" />
          <span className="text-xs text-slate-500 font-mono w-12 text-right">
            {idx + 1}/{snapshots.length}
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div className="bg-slate-900 rounded-lg p-3">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">Mid Price</p>
            <p className="text-xl font-bold font-mono text-slate-200">${cur.mid.toFixed(2)}</p>
          </div>
          <div className="bg-slate-900 rounded-lg p-3">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">Spread</p>
            <p className="text-xl font-bold font-mono text-sky-300">${cur.spread.toFixed(4)}</p>
          </div>
          <div className="bg-slate-900 rounded-lg p-3">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">Our Bid</p>
            <p className="text-xl font-bold font-mono text-sky-400">
              {cur.our_bid ? `$${cur.our_bid.toFixed(2)}` : '—'}
            </p>
          </div>
          <div className="bg-slate-900 rounded-lg p-3">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">Our Ask</p>
            <p className="text-xl font-bold font-mono text-rose-400">
              {cur.our_ask ? `$${cur.our_ask.toFixed(2)}` : '—'}
            </p>
          </div>
        </div>

        {/* Simple depth bar */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-sky-400 font-mono w-20 text-right">{cur.bid_qty} sh</span>
          <div className="flex-1 h-5 flex">
            <div className="bg-sky-400/30 border border-sky-400/50 rounded-l"
              style={{ width: `${Math.min(50, cur.bid_qty / 20)}%` }} />
            <div className="flex-1" />
            <div className="bg-rose-400/30 border border-rose-400/50 rounded-r"
              style={{ width: `${Math.min(50, cur.ask_qty / 20)}%` }} />
          </div>
          <span className="text-xs text-rose-400 font-mono w-20">{cur.ask_qty} sh</span>
        </div>
      </div>

      {/* Mid + quotes chart */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-300 mb-4">Mid Price &amp; Our Quotes</p>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="t" tick={{ fill: C.text, fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fill: C.text, fontSize: 10 }} tickFormatter={v => `$${v}`}
              domain={['auto', 'auto']} />
            <Tooltip content={<DarkTooltip />} />
            <Legend iconType="circle" />
            <Line type="monotone" dataKey="mid" name="Mid ($)" stroke={C.mid}
              strokeWidth={1.5} dot={false} />
            <Line type="stepAfter" dataKey="our_bid" name="Our Bid ($)" stroke={C.bid}
              strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls={false} />
            <Line type="stepAfter" dataKey="our_ask" name="Our Ask ($)" stroke={C.ask}
              strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Spread over time */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-sm font-semibold text-slate-300 mb-4">Effective Spread (¢)</p>
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={chartData} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="t" tick={{ fill: C.text, fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fill: C.text, fontSize: 10 }} tickFormatter={v => `${v}¢`} />
            <Tooltip content={<DarkTooltip />} />
            <ReferenceLine y={10} stroke="#475569" strokeDasharray="4 2" label={{ value: '1 tick', fill: '#64748b', fontSize: 10 }} />
            <Area type="monotone" dataKey="spread" name="Spread (¢)" stroke={C.spread}
              fill={C.spread} fillOpacity={0.15} strokeWidth={1.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
