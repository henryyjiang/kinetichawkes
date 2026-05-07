import type {
  SimData, BookEvent, HawkesEvent, QuoteEvent,
  FillEvent, PnlEvent, HaltEvent, BacktestStats,
} from './types'

export function parseSimData(text: string): SimData {
  const data: SimData = { book: [], hawkes: [], quotes: [], fills: [], pnl: [], halts: [] }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      switch (ev.type) {
        case 'book':   data.book.push(ev as BookEvent);   break
        case 'hawkes': data.hawkes.push(ev as HawkesEvent); break
        case 'quote':  data.quotes.push(ev as QuoteEvent); break
        case 'fill':   data.fills.push(ev as FillEvent);  break
        case 'pnl':    data.pnl.push(ev as PnlEvent);     break
        case 'halt':   data.halts.push(ev as HaltEvent);  break
      }
    } catch { /* skip malformed lines */ }
  }
  return data
}

export function computeStats(data: SimData): BacktestStats {
  const { pnl, fills } = data

  const lastPnl = pnl.at(-1)
  const totalPnlUsd = lastPnl ? lastPnl.realized / 1e9 : 0

  // Daily Sharpe: end-of-day PnL → daily returns → annualised
  const dayEnd = new Map<string, number>()
  for (const p of pnl) {
    const day = new Date(p.t / 1e6).toISOString().slice(0, 10)
    dayEnd.set(day, p.realized / 1e9)
  }
  const sortedDays = [...dayEnd.entries()].sort(([a], [b]) => a.localeCompare(b))
  const dailyRet: number[] = []
  let prev = 0
  for (const [, end] of sortedDays) { dailyRet.push(end - prev); prev = end }

  let dailySharpe = 0
  if (dailyRet.length >= 2) {
    const mean = dailyRet.reduce((a, b) => a + b, 0) / dailyRet.length
    const std = Math.sqrt(dailyRet.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyRet.length - 1))
    dailySharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0
  }

  // Fill stats
  const fillSharesBid = fills.filter(f => f.side === 'bid').reduce((a, f) => a + f.size, 0)
  const fillSharesAsk = fills.filter(f => f.side === 'ask').reduce((a, f) => a + f.size, 0)

  // Max drawdown over PnL series
  let peak = -Infinity, maxDrawdownUsd = 0
  for (const p of pnl) {
    const v = p.realized / 1e9
    if (v > peak) peak = v
    const dd = peak - v
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd
  }

  const peakInventory = pnl.reduce((m, p) => Math.max(m, Math.abs(p.inventory)), 0)

  return {
    totalPnlUsd, dailySharpe,
    totalFills: fills.length, fillSharesBid, fillSharesAsk,
    maxDrawdownUsd, peakInventory,
    sessionDays: sortedDays.length,
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export const ND = 1e9  // nanodollars per dollar

export function fmtUsd(n: number, decimals = 2): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}$${Math.abs(n).toFixed(decimals)}`
}

export function fmtTimeShort(t: number): string {
  return new Date(t / 1e6).toISOString().slice(11, 16)
}

export function fmtTimeFull(t: number): string {
  return new Date(t / 1e6).toISOString().slice(11, 19) + ' UTC'
}

// Thin an array to at most maxPts evenly-spaced points
export function thin<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr
  const step = Math.ceil(arr.length / maxPts)
  return arr.filter((_, i) => i % step === 0)
}

// Per-hour PnL buckets from pnl events
export function hourlyPnl(pnl: PnlEvent[]): { hour: string; pnl: number }[] {
  if (pnl.length === 0) return []
  const buckets = new Map<string, number>()
  for (const p of pnl) {
    const d = new Date(p.t / 1e6)
    const key = d.toISOString().slice(0, 13)  // "YYYY-MM-DDTHH"
    buckets.set(key, p.realized / ND)
  }
  const sorted = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
  const result: { hour: string; pnl: number }[] = []
  let prevPnl = 0
  for (const [key, endPnl] of sorted) {
    result.push({ hour: key.slice(11) + ':00 UTC', pnl: +(endPnl - prevPnl).toFixed(4) })
    prevPnl = endPnl
  }
  return result
}
