import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ComposedChart, Area, Line, LineChart,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { parseSimData, computeStats, thin, fmtTimeShort, fmtTimeFull, fmtUsd, ND } from './data'
import type { SimData, BacktestStats, HawkesEvent } from './types'
import { Plot3D } from './components/Plot3D'
import { HawkesSpike3D } from './components/HawkesSpike3D'

// ── Kinetic surface ───────────────────────────────────────────────────────────
const GRID_N   = 40
const fracGrid = Array.from({ length: GRID_N }, (_, i) => i / (GRID_N - 1))
const logQGrid = Array.from({ length: GRID_N }, (_, i) => 1.0 + i * (8.0 / (GRID_N - 1)))
const sigmoid  = (x: number) => 1 / (1 + Math.exp(-x))

function computeSurface(b0: number, b1: number, b2: number, b3: number) {
  return fracGrid.map(f =>
    logQGrid.map(lq => +sigmoid(b0 + b1 * f + b2 * lq + b3 * f * lq).toFixed(4))
  )
}

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEF_K = { b0: 4.213, b1: -4.153, b2: -2.269, b3: 1.982 }
const DEF_S = {
  gamma_as: 0.05, base_spread_cents: 1, k_hawkes: 1_000_000,
  max_inventory: 150, inv_one_side_frac: 0.40, min_fill_prob: 0.001, default_size: 100,
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const section: React.CSSProperties = { marginBottom: 10 }
const secHead: React.CSSProperties = {
  color: '#333', textTransform: 'uppercase', letterSpacing: 3,
  marginBottom: 8, paddingBottom: 5, borderBottom: '1px solid #1a1a1a',
}
const metaLbl: React.CSSProperties = {
  color: '#3a3a3a', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 3,
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0d0d0d', border: '1px solid #1e1e1e', padding: '7px 10px' }}>
      <div style={{ color: '#444', marginBottom: 3 }}>{label}</div>
      {payload.map((p: { name: string; value: number; color: string }) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(4) : p.value}
        </div>
      ))}
    </div>
  )
}

// ── Slider ────────────────────────────────────────────────────────────────────
function Slider({
  label, value, min, max, step, onChange, fmt,
}: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void; fmt?: (v: number) => string
}) {
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ color: '#555' }}>{label}</span>
        <span style={{ color: '#aaa' }}>{fmt ? fmt(value) : value.toFixed(3)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)} />
    </div>
  )
}

function ResetBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      marginTop: 5, background: 'transparent', border: '1px solid #1e1e1e',
      color: '#333', padding: '2px 10px', cursor: 'pointer', letterSpacing: 1,
    }}>
      reset
    </button>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [data,      setData]      = useState<SimData | null>(null)
  const [stats,     setStats]     = useState<BacktestStats | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [runState,  setRunState]  = useState<'idle' | 'running' | 'error'>('idle')
  const [runMsg,    setRunMsg]    = useState('')
  const [streaming, setStreaming] = useState(false)
  const [liveHawkes, setLiveHawkes] = useState<HawkesEvent[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Kinetic sliders
  const [b0, setB0] = useState(DEF_K.b0)
  const [b1, setB1] = useState(DEF_K.b1)
  const [b2, setB2] = useState(DEF_K.b2)
  const [b3, setB3] = useState(DEF_K.b3)

  // Strategy sliders
  const [gammaAs,     setGammaAs]     = useState(DEF_S.gamma_as)
  const [spreadCents, setSpreadCents] = useState(DEF_S.base_spread_cents)
  const [kHawkes,     setKHawkes]     = useState(DEF_S.k_hawkes)
  const [maxInv,      setMaxInv]      = useState(DEF_S.max_inventory)
  const [oneSideFrac, setOneSideFrac] = useState(DEF_S.inv_one_side_frac)
  const [minFillProb, setMinFillProb] = useState(DEF_S.min_fill_prob)
  const [ordSize,     setOrdSize]     = useState(DEF_S.default_size)

  const ingest = useCallback((text: string) => {
    try {
      const parsed = parseSimData(text)
      setData(parsed)
      setStats(computeStats(parsed))
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetch(import.meta.env.BASE_URL + 'sim_data.jsonl')
      .then(r => r.text()).then(ingest)
      .catch(() => setLoading(false))
  }, [ingest])

  // ── Run ───────────────────────────────────────────────────────────────────
  const run = useCallback(async () => {
    setRunState('running')
    setRunMsg('running…')
    setStreaming(true)
    setLiveHawkes([])

    // Poll the growing output file for live Hawkes events during sim run
    pollRef.current = setInterval(async () => {
      try {
        const text = await fetch(`${import.meta.env.BASE_URL}sim_data.jsonl?t=${Date.now()}`).then(r => r.text())
        setLiveHawkes(parseSimData(text).hawkes)
      } catch { /* file not ready yet */ }
    }, 600)

    try {
      const cfg = {
        buy:    { mu: 0.4976978913926123, alpha: 928.3897977902539, beta: 1856.5891265416074 },
        sell:   { mu: 0.5394246357452892, alpha: 3247.393140710201, beta: 3565.0758382923336 },
        cancel: { mu: 3.7814915972021597, alpha: 35.31559277914742, beta: 67.73026525811643 },
        kinetic: { beta0: b0, beta1: b1, beta2: b2, beta3: b3 },
        strategy: {
          gamma_as:          gammaAs,
          base_spread:       Math.round(spreadCents * 10_000_000),
          k_hawkes:          kHawkes,
          max_inventory:     maxInv,
          inv_one_side_frac: oneSideFrac,
          min_fill_prob:     minFillProb,
          default_size:      ordSize,
        },
      }
      // /api/run is only available when running locally with the C++ backend.
      // On GitHub Pages (BASE_URL !== '/') we show a static demo notice instead.
      if (import.meta.env.BASE_URL !== '/') {
        throw new Error('live re-simulation requires running locally — see README')
      }
      const r = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error ?? 'run failed')

      setRunMsg(`done — ${j.lines} snapshots`)
      setRunState('idle')
      const text = await fetch(`/sim_data.jsonl?t=${Date.now()}`).then(rr => rr.text())
      ingest(text)
    } catch (e) {
      setRunMsg(String(e).slice(0, 120))
      setRunState('error')
    } finally {
      if (pollRef.current) clearInterval(pollRef.current)
      setStreaming(false)
    }
  }, [b0, b1, b2, b3, gammaAs, spreadCents, kHawkes, maxInv, oneSideFrac, minFillProb, ordSize, ingest])

  // Which Hawkes events to feed the spike chart
  const spikeEvents: HawkesEvent[] = streaming ? liveHawkes : (data?.hawkes ?? [])

  // ── Kinetic 3D surface ────────────────────────────────────────────────────
  const surface = useMemo(() => computeSurface(b0, b1, b2, b3), [b0, b1, b2, b3])

  const plotData3D = useMemo(() => [{
    type: 'surface',
    x: logQGrid.map(lq => +Math.exp(lq).toFixed(1)),
    y: fracGrid, z: surface,
    colorscale: [[0,'#111'],[0.35,'#0a2a0a'],[0.65,'#0d5e0d'],[1.0,'#0f0']],
    showscale: true,
    colorbar: {
      title: { text: 'P(fill)', font: { color: '#555', size: 9 } },
      tickfont: { color: '#555', size: 9 }, len: 0.55,
    },
    hovertemplate: 'Q: %{x}<br>frac: %{y:.2f}<br>P: %{z:.3f}<extra></extra>',
  }], [surface])

  const layout3D = useMemo(() => ({
    paper_bgcolor: '#0d0d0d', plot_bgcolor: '#0d0d0d',
    font: { color: '#555', family: 'Roboto', size: 11 },
    margin: { l: 0, r: 0, t: 10, b: 0 },
    scene: {
      bgcolor: '#0d0d0d',
      xaxis: { title: { text: 'Q (shares)', font: { color: '#555', size: 9 } }, tickfont: { color: '#444', size: 8 }, gridcolor: '#1a1a1a', type: 'log' as const },
      yaxis: { title: { text: 'frac q/Q',   font: { color: '#555', size: 9 } }, tickfont: { color: '#444', size: 8 }, gridcolor: '#1a1a1a' },
      zaxis: { title: { text: 'P(fill)',     font: { color: '#555', size: 9 } }, tickfont: { color: '#444', size: 8 }, gridcolor: '#1a1a1a', range: [0, 1] },
      camera: { eye: { x: 1.6, y: -1.6, z: 0.8 } },
    },
  }), [])

  // ── Chart data ────────────────────────────────────────────────────────────
  const pnlSeries = useMemo(() => !data ? [] : thin(
    data.pnl.map(p => ({ t: fmtTimeShort(p.t), pnl: +(p.realized / ND).toFixed(4), inv: p.inventory })),
    600,
  ), [data])

  const bookChartData = useMemo(() => !data ? [] : thin(
    data.book.map(b => {
      const qt = data.quotes.filter(q => q.t <= b.t).at(-1)
      return {
        t:       fmtTimeShort(b.t),
        mid:     +(b.mid / ND).toFixed(2),
        our_bid: qt?.bid ? +(qt.bid / ND).toFixed(2) : null,
        our_ask: qt?.ask ? +(qt.ask / ND).toFixed(2) : null,
      }
    }),
    500,
  ), [data])

  const hawkesSeries = useMemo(() => !data ? [] : thin(
    data.hawkes.map(h => ({
      t: fmtTimeShort(h.t),
      lam_buy:   +h.lam_buy.toFixed(4),
      lam_sell:  +h.lam_sell.toFixed(4),
      imbalance: +h.imbalance.toFixed(4),
    })),
    600,
  ), [data])

  const fillRows = useMemo(() => !data ? [] :
    data.fills.map((f, i) => ({
      t:      fmtTimeFull(f.t),
      side:   f.side,
      price:  +(f.price / ND).toFixed(2),
      size:   f.size,
      cumPnl: +(f.pnl_delta / ND).toFixed(4),
      delta:  i > 0 ? +((f.pnl_delta - data.fills[i - 1].pnl_delta) / ND).toFixed(4) : +(f.pnl_delta / ND).toFixed(4),
    })),
  [data])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: '#0d0d0d', color: '#c8c8c8', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{
        borderBottom: '1px solid #1a1a1a', padding: '8px 18px',
        display: 'flex', alignItems: 'center', gap: 16,
        position: 'sticky', top: 0, background: '#0d0d0d', zIndex: 10,
      }}>
        <span style={{ color: '#0f0', letterSpacing: 1 }}>hawkes-hft</span>
        <span style={{ color: '#1e1e1e' }}>|</span>
        <span style={{ color: '#333' }}>MSFT · XNAS.ITCH · MBO replay</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          {runMsg && (
            <span style={{ color: runState === 'error' ? '#f44' : '#444' }}>{runMsg}</span>
          )}
          <button onClick={run} disabled={runState === 'running'} style={{
            background:    runState === 'running' ? 'transparent' : '#0f0',
            color:         runState === 'running' ? '#0f0' : '#000',
            border:        '1px solid #0f0',
            padding:       '4px 18px',
            letterSpacing: 1,
            cursor:        runState === 'running' ? 'wait' : 'pointer',
            textTransform: 'uppercase',
          }}>
            {runState === 'running' ? '▶ running' : '▶ run sim'}
          </button>
        </div>
      </div>

      <div style={{ padding: '12px 18px' }}>

        {/* Stats */}
        {stats && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 6, marginBottom: 10 }}>
            {[
              { label: 'total pnl',    value: fmtUsd(stats.totalPnlUsd),      color: stats.totalPnlUsd >= 0 ? '#0f0' : '#f44' },
              { label: 'daily sharpe', value: stats.dailySharpe.toFixed(2),    color: stats.dailySharpe > 2 ? '#0f0' : '#ccc' },
              { label: 'our fills',    value: String(stats.totalFills) },
              { label: 'peak inv',     value: `${stats.peakInventory} sh` },
              { label: 'max drawdown', value: fmtUsd(-stats.maxDrawdownUsd),   color: '#f44' },
              { label: 'session days', value: String(stats.sessionDays) },
            ].map(s => (
              <div key={s.label} style={section}>
                <div style={metaLbl}>{s.label}</div>
                <div style={{ color: s.color ?? '#ccc', marginTop: 2 }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Parameters + kinetic surface */}
        <div style={section}>
          <div style={secHead}>parameters</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.8fr', gap: 20 }}>

            <div>
              <div style={{ ...metaLbl, marginBottom: 10 }}>
                kinetic fill model  σ(β₀ + β₁·f + β₂·lnQ + β₃·f·lnQ)
              </div>
              <Slider label="β₀  intercept"   value={b0} min={-8}  max={8}  step={0.05} onChange={setB0} />
              <Slider label="β₁  frac slope"  value={b1} min={-12} max={0}  step={0.05} onChange={setB1} />
              <Slider label="β₂  logQ slope"  value={b2} min={-5}  max={5}  step={0.05} onChange={setB2} />
              <Slider label="β₃  interaction" value={b3} min={-3}  max={5}  step={0.05} onChange={setB3} />
              <ResetBtn onClick={() => { setB0(DEF_K.b0); setB1(DEF_K.b1); setB2(DEF_K.b2); setB3(DEF_K.b3) }} />
            </div>

            <div>
              <div style={{ ...metaLbl, marginBottom: 10 }}>strategy parameters</div>
              <Slider label="γ  risk aversion"     value={gammaAs}     min={0.001}  max={0.1}       step={0.001}   onChange={setGammaAs}     fmt={v => v.toExponential(2)} />
              <Slider label="base spread (¢)"       value={spreadCents} min={1}      max={20}        step={0.5}     onChange={setSpreadCents} fmt={v => `${v.toFixed(1)}¢`} />
              <Slider label="k_hawkes spread/ev·s"  value={kHawkes}     min={0}      max={5_000_000} step={50_000}  onChange={setKHawkes}     fmt={v => `${(v/1e6).toFixed(2)}M`} />
              <Slider label="max inventory (sh)"    value={maxInv}      min={10}     max={500}       step={10}      onChange={setMaxInv}      fmt={v => `${v} sh`} />
              <Slider label="one-side frac"         value={oneSideFrac} min={0.1}    max={0.9}       step={0.05}    onChange={setOneSideFrac} fmt={v => `${(v*100).toFixed(0)}%`} />
              <Slider label="min fill prob"         value={minFillProb} min={0.0001} max={0.05}      step={0.0001}  onChange={setMinFillProb} fmt={v => v.toExponential(2)} />
              <Slider label="order size (sh)"       value={ordSize}     min={10}     max={500}       step={10}      onChange={setOrdSize}     fmt={v => `${v} sh`} />
              <ResetBtn onClick={() => {
                setGammaAs(DEF_S.gamma_as); setSpreadCents(DEF_S.base_spread_cents)
                setKHawkes(DEF_S.k_hawkes); setMaxInv(DEF_S.max_inventory)
                setOneSideFrac(DEF_S.inv_one_side_frac); setMinFillProb(DEF_S.min_fill_prob)
                setOrdSize(DEF_S.default_size)
              }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ ...metaLbl, marginBottom: 6 }}>fill probability surface</div>
              <div style={{ flex: 1, minHeight: 270 }}>
                <Plot3D data={plotData3D} layout={layout3D} className="h-full" />
              </div>
            </div>
          </div>
        </div>

        {/* Hawkes spike 3D */}
        <div style={section}>
          <div style={secHead}>
            hawkes intensity spikes
            {streaming && <span style={{ color: '#0f0', marginLeft: 12, letterSpacing: 0 }}>● live</span>}
            {!streaming && spikeEvents.length > 0 && <span style={{ color: '#333', marginLeft: 12, letterSpacing: 0 }}>playback</span>}
          </div>
          <div style={{ height: 300 }}>
            <HawkesSpike3D events={spikeEvents} streaming={streaming} />
          </div>
        </div>

        {/* Data sections */}
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#222' }}>
            loading sim_data.jsonl…
          </div>
        ) : !data ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#222' }}>
            <div>no data — press ▶ run sim or place sim_data.jsonl in public/</div>
          </div>
        ) : (
          <>
            {/* PnL & Inventory */}
            <div style={section}>
              <div style={secHead}>pnl &amp; inventory</div>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={pnlSeries} margin={{ left: 10, right: 40, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#141414" />
                  <XAxis dataKey="t" tick={{ fill: '#333', fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis yAxisId="pnl" tick={{ fill: '#333', fontSize: 11 }} tickFormatter={v => `$${v.toFixed(0)}`} />
                  <YAxis yAxisId="inv" orientation="right" tick={{ fill: '#333', fontSize: 11 }} tickFormatter={v => `${v}sh`} />
                  <Tooltip content={<Tip />} />
                  <ReferenceLine yAxisId="pnl" y={0} stroke="#1e1e1e" />
                  <Area yAxisId="pnl" type="monotone" dataKey="pnl" name="PnL ($)"
                    stroke="#0f0" fill="#0f0" fillOpacity={0.07} strokeWidth={1.5} dot={false} />
                  <Line yAxisId="inv" type="stepAfter" dataKey="inv" name="inv (sh)"
                    stroke="#444" strokeWidth={1} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Book + Hawkes 2D */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div style={section}>
                <div style={secHead}>mid price &amp; our quotes</div>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={bookChartData} margin={{ left: 5, right: 5, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#141414" />
                    <XAxis dataKey="t" tick={{ fill: '#333', fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#333', fontSize: 11 }} tickFormatter={v => `$${v}`} domain={['auto', 'auto']} />
                    <Tooltip content={<Tip />} />
                    <Line type="monotone"  dataKey="mid"     name="mid"     stroke="#333" strokeWidth={1}   dot={false} />
                    <Line type="stepAfter" dataKey="our_bid" name="our bid" stroke="#38bdf8" strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
                    <Line type="stepAfter" dataKey="our_ask" name="our ask" stroke="#fb7185" strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div style={section}>
                <div style={secHead}>hawkes intensity λ(t)</div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={hawkesSeries} margin={{ left: 5, right: 5, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#141414" />
                    <XAxis dataKey="t" tick={{ fill: '#333', fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis yAxisId="lam" tick={{ fill: '#333', fontSize: 11 }} />
                    <YAxis yAxisId="imb" orientation="right" domain={[0,1]} tick={{ fill: '#333', fontSize: 11 }} />
                    <Tooltip content={<Tip />} />
                    <Line yAxisId="lam" type="monotone" dataKey="lam_buy"   name="λ_buy"     stroke="#38bdf8" strokeWidth={1}   dot={false} />
                    <Line yAxisId="lam" type="monotone" dataKey="lam_sell"  name="λ_sell"    stroke="#fb7185" strokeWidth={1}   dot={false} />
                    <Line yAxisId="imb" type="monotone" dataKey="imbalance" name="imbalance" stroke="#fbbf24" strokeWidth={0.8} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Fill log */}
            {fillRows.length > 0 && (
              <div style={section}>
                <div style={secHead}>fill log  ({fillRows.length} fills)</div>
                <div style={{ overflowY: 'auto', maxHeight: 320 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ color: '#333', borderBottom: '1px solid #1a1a1a' }}>
                        {['time (utc)', 'side', 'price', 'size', 'fill pnl', 'cum pnl'].map(h => (
                          <th key={h} style={{ textAlign: 'left', padding: '3px 10px 6px 0', fontWeight: 'normal', letterSpacing: 1 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fillRows.map((f, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #111' }}>
                          <td style={{ padding: '3px 10px 3px 0', color: '#333' }}>{f.t}</td>
                          <td style={{ padding: '3px 10px 3px 0', color: f.side === 'bid' ? '#38bdf8' : '#fb7185' }}>
                            {f.side === 'bid' ? '↑ bid' : '↓ ask'}
                          </td>
                          <td style={{ padding: '3px 10px 3px 0' }}>${f.price}</td>
                          <td style={{ padding: '3px 10px 3px 0', color: '#555' }}>{f.size} sh</td>
                          <td style={{ padding: '3px 10px 3px 0', color: f.delta >= 0 ? '#0f0' : '#f44' }}>{fmtUsd(f.delta)}</td>
                          <td style={{ padding: '3px 0', color: f.cumPnl >= 0 ? '#0f0' : '#f44', fontWeight: 'bold' }}>{fmtUsd(f.cumPnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
