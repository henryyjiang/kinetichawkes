export interface BookEvent {
  t: number
  mid: number      // nanodollars
  spread: number   // nanodollars
  bid_qty: number
  ask_qty: number
}

export interface HawkesEvent {
  t: number
  lam_buy: number
  lam_sell: number
  lam_cancel: number
  imbalance: number
}

export interface QuoteEvent {
  t: number
  bid: number    // nanodollars (0 = no bid)
  ask: number    // nanodollars (0 = no ask)
  size: number
}

export interface FillEvent {
  t: number
  side: 'bid' | 'ask'
  price: number      // nanodollars
  size: number
  pnl_delta: number  // nanodollars, cumulative total PnL at time of fill
}

export interface PnlEvent {
  t: number
  realized: number    // nanodollars — total mark-to-market PnL from simulator
  unrealized: number  // nanodollars — always 0 from current sim
  inventory: number   // signed shares
}

export interface HaltEvent {
  t: number
  reason: string
}

export interface SimData {
  book: BookEvent[]
  hawkes: HawkesEvent[]
  quotes: QuoteEvent[]
  fills: FillEvent[]
  pnl: PnlEvent[]
  halts: HaltEvent[]
}

export interface BacktestStats {
  totalPnlUsd: number
  dailySharpe: number
  totalFills: number
  fillSharesBid: number
  fillSharesAsk: number
  maxDrawdownUsd: number
  peakInventory: number
  sessionDays: number
}
