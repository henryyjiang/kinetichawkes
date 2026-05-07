# hawkes-kinetic HFT engine

**Framework Doc v0.6** · C++20 · L3 Order Book · Hawkes Process + Kinetic Theory · Databento XNAS.ITCH

---

## Table of Contents

1. [Strategy Overview](#1-strategy-overview)
2. [Data Source — Databento](#2-data-source--databento)
3. [Mathematical Core](#3-mathematical-core)
4. [C++ Architecture](#4-c-architecture)
5. [Signal Generation](#5-signal-generation)
6. [Risk & Execution](#6-risk--execution)
7. [Backtesting Methodology](#7-backtesting-methodology)
8. [GUI Dashboard](#8-gui-dashboard)
9. [Dev Roadmap](#9-dev-roadmap)
10. [Resolved Decisions](#10-resolved-decisions)
11. [Open Questions](#11-open-questions)
12. [References](#12-references)

---

## 1. Strategy Overview

The strategy operates as a **market maker** on MSFT using L3 order book data from Databento. It quotes a bid and ask simultaneously, capturing the spread, while using two models to avoid adverse selection:

- **3 independent Hawkes processes** — one each for market buy arrivals, market sell arrivals, and cancellations
- A **kinetic theory queue model** — estimates queue depletion and fill probability at each price level

### Pipeline

```
Databento MBO feed → Reconstruct L3 Book → Hawkes + Kinetic Models → InventoryManager → Quote Decision → Risk Gate → Execute/Sim
```

### Edge

- Quote the spread when Hawkes intensity is low (calm flow = safe to quote)
- Widen or cancel quotes when total market order intensity λ(t) spikes
- Use queue position + kinetic fill probability to decide when quoting is worth it
- Skew quotes based on current inventory to mean-revert position (Avellaneda-Stoikov)

### Scope Constraints

- Single instrument: MSFT
- No cross-asset signals
- No latency optimization (sim only, not co-lo)
- Well-documented, readable C++20 code over maximum performance
- Databento `XNAS.ITCH` MBO schema as data source

---

## 2. Data Source — Databento

### Why Databento

Databento provides Nasdaq TotalView-ITCH via the `XNAS.ITCH` dataset with a clean API and first-party C++, Python, and Rust client libraries. The `mbo` (market-by-order) schema is true L3 — every individual order add, cancel, modify, and execution timestamped to the nanosecond, with multi-week history accessible pay-per-query.

- **$125 free credit on signup** — enough for several weeks of single-ticker MBO data
- **C++ client library** (`databento-cpp`, C++17+, integrates via CMake FetchContent)
- **Usage-based pricing** — quote cost before pulling with `metadata.get_cost()`
- Coverage from 2018 onwards for `XNAS.ITCH`

### Account Setup

1. Sign up at [databento.com](https://databento.com) — $125 credit applied automatically, no card required to start
2. **Portal → API Keys** → create a key
3. Store it as an environment variable: `export DATABENTO_API_KEY=your_key_here`
4. Never hardcode the key in source — load with `db::HistoricalBuilder().SetKeyFromEnv()`

### Data Acquired

**`data/MSFT_20240303_20240314_mbo.dbn`** — Mar 3–14 2024 (2 weeks, 10 trading days)

- Start: `2024-03-03T00:00:00 UTC` (midnight, includes full order book snapshot)
- End: `2024-03-14T21:00:00 UTC` (16:00 ET close)
- ~54M session events across both weeks
- First record is action `'R'` (clear/snapshot) at midnight — expected, marks synthetic book state before open
- No further API calls needed; all development replays from this file

**`data/MSFT_20240303_20240314_mbo_cache.parquet`** — session-filtered parquet cache (13:30–21:00 UTC)

- Columns: `ts_ns, action, side, price, size, order_id`
- 54,037,865 rows; loads in ~0.8s vs 111s for raw DBN iteration
- Built by `scripts/rebuild_cache.py` (inline, not committed)

### MBO Schema — Field Reference

Each `MboMsg` record from `XNAS.ITCH`:

| Field | Type | Description |
|-------|------|-------------|
| `hd.ts_event` | `uint64_t` | Nanosecond timestamp (exchange time, UTC) |
| `action` | `char` | `'A'`=Add, `'C'`=Cancel, `'M'`=Modify, `'T'`=Trade, `'F'`=Fill, `'R'`=Clear book |
| `side` | `char` | `'B'`=Bid side, `'A'`=Ask side, `'N'`=None |
| `order_id` | `uint64_t` | Unique order reference |
| `size` | `uint32_t` | Shares |
| `price` | `int64_t` | Fixed-point nanodollars: $1.00 = `1000000000` |
| `flags` | `uint8_t` | Bitmask (last msg in event, snapshot indicator, etc.) |

> **Price encoding:** Databento prices are in **nanodollars** (1e-9 dollars). MSFT at $420.00 = `420000000000`. Store as `int64_t` throughout. To display: `price / 1e9`.

### Mapping MBO Actions to Hawkes Event Types

```cpp
// F.side='A' → passive ask filled → market buy (0); F.side='B' → market sell (1)
inline int hawkes_event_type(char action, char side) {
    if (action == 'F')
        return (side == 'A') ? 0 : 1;
    if (action == 'C')
        return 2;
    return -1;
}
```

Note: `'T'` (Trade) records have `order_id=0` and are handled by the paired `'F'` Fill record. Only `'F'` carries the passive-side indicator.

---

## 3. Mathematical Core

### 3.1 Three Independent Hawkes Processes

**Why independent:** Fitting the full 3×3 multivariate excitation matrix requires more data and is harder to regularize. Three independent processes still capture the key signals — per-side intensity and the buy/sell ratio — at lower overfitting risk on a limited budget.

**Intensity for process i:**

```
λᵢ(t) = μᵢ + Σ_{t_k < t} αᵢ · exp(−βᵢ · (t − t_k))
```

**Recursive O(1) update:**

When an event of type i arrives at time t:
```
λᵢ(t) = μᵢ + exp(−βᵢ · Δt) · (λᵢ(t⁻) − μᵢ) + αᵢ
```

When any other event occurs at time t (time-decay only):
```
λᵢ(t) = μᵢ + exp(−βᵢ · Δt) · (λᵢ(t⁻) − μᵢ)
```

**Stationarity condition:** `αᵢ / βᵢ < 1` (branching ratio < 1). Check after calibration.

**Calibrated parameters (MSFT Week 1, 2024-03-04 to 2024-03-08):**

| Process | μ | α | β | α/β | E[λ] |
|---------|---|---|---|-----|------|
| buy MO  | 0.4977 | 928.39  | 1856.59 | 0.500 | 0.995 ev/s |
| sell MO | 0.5394 | 3247.39 | 3565.08 | 0.911 | 6.053 ev/s |
| cancel  | 3.7815 | 35.32   | 67.73   | 0.521 | 7.901 ev/s |

Cancels were 1/15-subsampled for tractable MLE; parameters are consistent estimates. The sell branching ratio (0.911) is near-critical — sell flow is substantially more self-exciting than buy flow on MSFT.

**Signals:**
- `λ⁰ / (λ⁰ + λ¹)` — buy pressure ratio (>0.6 = strong directional buy flow)
- `λ⁰ + λ¹` — total market order intensity (spike → danger to quotes)
- `λ²` — cancel intensity (spike → queue thinning at TOB → consider quoting)

### 3.2 Kinetic Theory Queue Model

Adapted from Cont, Stoikov & Talreja (2010).

**Fill probability (conditional logistic model):**

```
P_fill(q, Q) = sigmoid(β₀ + β₁·(q/Q) + β₂·log(Q) + β₃·(q/Q)·log(Q))
```

`Q` = total shares at that level, `q` = shares ahead of our order. Hard boundary guards apply: `q=0 → P=1`, `q≥Q → P=0`.

**Why condition on log(Q):** The power-law model `P = 1 − (q/Q)^γ` is mis-specified for MSFT ITCH data. Empirically, fill rate *increases* with `q/Q` because large queues (high `Q`) sit at actively-traded price levels — even orders deep in the queue fill at ~20% — while thin levels (low `Q`) rarely see executions regardless of queue position. `Q` is a proxy for price-level activity. A single-variable power-law cannot capture this: for any `γ > 0`, `P` is monotone-decreasing in `q/Q` regardless of `Q`.

**Interaction term `β₃`:** Allows the frac slope to vary with `Q`. On active levels (large `Q`), being further back in queue is penalized less severely. Calibration is expected to give `β₁ < 0`, `β₂ > 0`, `β₃ > 0`.

**Marginal priority (increase in P per unit decrease in frac):**

```
dP/d(frac) = (β₁ + β₃·log(Q)) · P·(1−P)
marginal_priority = −(β₁ + β₃·log(Q)) · P·(1−P)
```

Positive whenever `β₁ + β₃·log(Q) < 0`, which holds for all sensible calibrations.

**Calibration:** `scripts/fit_gamma.py` runs an L3 book replay to track `(frac, Q)` at placement for each fill and cancel, then fits a logistic regression on `X = [frac, log(Q), frac·log(Q)]` with `sklearn.linear_model.LogisticRegression`. Outputs `β₀..β₃` to `configs/MSFT.json`.

**Queue tracking (FIFO):**
- On our order placement: `shares_ahead` = all prior resting shares at that level
- On cancel event at our level: `shares_ahead -= cancelled_size`
- On trade at our level: `shares_ahead -= executed_size`

### 3.3 Inventory Skew (Avellaneda-Stoikov)

```
r(s, q, t) = s − q · γ_AS · σ² · (T − t)
```

`s` = mid price (nanodollars), `q` = current inventory (signed shares), `γ_AS` = risk aversion coefficient, `σ²` = EWMA realized variance in nanodollar²/s, `T − t` = session seconds remaining.

**Quote placement:**
```
half_spread = base_spread/2 + k_hawkes · max(0, λ_total − λ_baseline)

bid_px = r − half_spread
ask_px = r + half_spread
```

**Interpretation:** Long inventory → `r` shifts down → bid less aggressive, ask more aggressive → strategy leans toward selling. Spread widens when Hawkes intensity spikes above the calibrated steady-state level.

**PnL tracking:**
```
total_pnl = cash + inventory × mid_price
cash decrements on fills (buy: −price×size; sell: +price×size)
```

---

## 4. C++ Architecture

### Project Layout

```
hawkes-hft/
├── src/
│   ├── feed/
│   │   └── DatabentoAdapter.hpp     # MboMsg → OrderEvent
│   ├── book/
│   │   ├── OrderBook.hpp            # L3 book (sorted maps, FIFO levels)
│   │   └── Level.hpp                # price level + queue position tracking
│   ├── models/
│   │   ├── HawkesProcess.hpp        # single independent process
│   │   ├── HawkesTriple.hpp         # 3-process wrapper
│   │   └── KineticQueue.hpp         # fill probability + queue depletion
│   ├── strategy/
│   │   └── InventoryManager.hpp     # A-S reservation price, inventory, PnL
│   ├── sim/
│   │   └── Simulator.hpp            # DBN replay loop + snapshot logging
│   ├── risk/
│   │   └── RiskGate.hpp             # [Phase 4] hard limits + halt detection
│   └── util/
│       ├── PriceUtils.hpp           # nanodollar conversions + tick rounding
│       └── Logger.hpp               # structured JSONL event log
├── tests/
│   └── test_kinetic_queue.cpp       # Catch2 unit tests (145 assertions)
├── data/                            # .dbn + .parquet files (gitignored)
├── scripts/
│   ├── calibrate_hawkes.py          # Ozaki MLE → configs/MSFT.json
│   └── fit_gamma.py                 # L3 book replay → γ MLE diagnostic
├── configs/
│   └── MSFT.json                    # calibrated parameters (Hawkes + kinetic)
├── gui/                             # [Phase 6] React dashboard
└── CMakeLists.txt
```

**Dependencies (all via CMake FetchContent):** `databento-cpp` (includes `nlohmann/json`), `Catch2 v3.5.3`.

### Key Data Structures

```cpp
enum class EventType : uint8_t { Add, Cancel, Modify, Trade, Fill, Clear, Halt, Unknown };

struct OrderEvent {
    int64_t   timestamp_ns;
    EventType type;
    uint64_t  order_id;
    int32_t   size;
    int64_t   price;        // nanodollars
    int8_t    side;         // 1=bid, -1=ask, 0=unknown
};

struct Level {
    int64_t price, total_quantity, shares_ahead;
    bool    we_have_order = false;
    std::map<uint64_t, int32_t> orders;   // insertion order = FIFO
};

struct OrderBook {
    std::map<int64_t, Level, std::greater<int64_t>> bids;
    std::map<int64_t, Level>                         asks;
    std::unordered_map<uint64_t, OrderMeta>          order_index;
    EffectiveTOB effective_tob() const;  // skips crossed ghost levels
};

struct HawkesProcess {
    double mu, alpha, beta, lambda_cur;
    void decay(int64_t t_ns);   // time decay only
    void fire(int64_t t_ns);    // decay + jump
};

struct HawkesTriple {
    HawkesProcess buy, sell, cancel;
    void update(int64_t t_ns, int event_type);
    double flow_imbalance() const;
    double total_mo_intensity() const;
};

struct KineticQueue {
    double beta0, beta1, beta2, beta3;
    double fill_prob(int64_t q, int64_t Q) const noexcept;       // logistic; guards: q=0→1, q≥Q→0
    double fill_prob(const Level&) const noexcept;
    double marginal_priority(int64_t q, int64_t Q) const noexcept; // −(β₁+β₃·logQ)·P·(1−P)
};

struct InventoryManager {
    double  gamma_as, base_spread, k_hawkes, baseline_mo, ewma_alpha;
    int32_t max_inventory;
    int64_t session_close_ns;

    int32_t inventory;
    int64_t cash;
    double  sigma_sq;   // EWMA variance, nanodollar²/s

    void      update_vol(int64_t t_ns, int64_t mid_px);
    void      on_fill(int8_t side, int64_t price, int32_t size);
    int64_t   reservation_price(int64_t mid_px, int64_t t_ns) const;
    int64_t   total_pnl(int64_t mid_px) const;
    QuoteSkew compute_quotes(int64_t mid_px, int64_t t_ns, double total_mo) const;
};
```

### Config Loading

`main.cpp` loads `configs/MSFT.json` via `nlohmann/json` (bundled with databento-cpp):

```bash
./hawkes-hft data/MSFT_20240303_20240314_mbo.dbn configs/MSFT.json [log_interval]
```

JSONL goes to stdout; stats/errors to stderr.

### Design Notes

- **Single-threaded** — event loop processes records sequentially. Deterministic, easy to debug.
- **Nanodollar prices everywhere** — `int64_t` throughout. Display converts to `double` only at Logger/GUI boundary.
- **UTC session filter** — 09:30–16:00 ET = 13:30:00–21:00:00 UTC.
- **Hawkes double-decay** — in `HawkesTriple::update`, decay all three first, then fire the matching one. Calling `decay` then `fire` on the same process would double-apply the decay interval.
- **effective_tob()** — ITCH MBO data contains persistent far-from-market pre-auction ghost levels (e.g., $412 ask sitting behind a $417 bid) that never cancel and keep raw TOB crossed. `effective_tob()` walks inward until it finds an uncrossed pair.

---

## 5. Signal Generation

```cpp
QuoteSkew InventoryManager::compute_quotes(int64_t mid_px, int64_t t_ns, double total_mo) {
    if (T_remaining < 300.0 || abs(inventory) >= max_inventory)
        return {.valid = false};

    int64_t r = reservation_price(mid_px, t_ns);   // A-S skew

    double excess    = max(0.0, total_mo - baseline_mo);
    int64_t half_spr = base_spread/2 + k_hawkes * excess;

    return {r - half_spr, r + half_spr, true};
}
```

### Signal Table

| Signal | Source | Action |
|--------|--------|--------|
| `flow_imbalance > 0.65` | λ⁰/(λ⁰+λ¹) | Reflected in reservation price skew |
| `total_mo` spikes above `baseline_mo` | λ⁰+λ¹ | Widen spread via `k_hawkes` |
| `total_mo` spikes past hard threshold | λ⁰+λ¹ | [Phase 4] Cancel both quotes |
| `P_fill < min_threshold` | KineticQueue | [Phase 4] Don't place at that level |
| `|inventory| ≥ max_inventory` | InventoryManager | Return `valid=false`, no quote |
| `T_remaining < 300s` | InventoryManager | Stop quoting before close |

---

## 6. Risk & Execution

### Hard Risk Limits (Phase 4 — `RiskGate.hpp`)

| Trigger | Action | Severity |
|---------|--------|----------|
| `|inventory| > MAX_INV` | Cancel all quotes immediately | CRITICAL |
| Daily PnL `< -MAX_LOSS` | Halt entire session | CRITICAL |
| `total_mo > LAMBDA_HALT` | Cancel exposed quotes within next event | HIGH |
| Action `'R'` (clear book) | Freeze all orders | HIGH |
| No MBO events for > N ms | Cancel all (stale book) | HIGH |
| Reach 15:55 ET | Cancel all open quotes (pre-close) | MEDIUM |

### PnL Decomposition

```
total_pnl      = cash + inventory × mid_price
cash           = Σ (side × price × size) over fills
realized_pnl   = total_pnl when inventory = 0
spread_revenue = fills × quoted_half_spread (theoretical)
adverse_sel    = realized_pnl − spread_revenue  (target: near zero or small negative)
```

---

## 7. Backtesting Methodology

### Data Split

| Period | Use |
|--------|-----|
| Week 1 — Mar 4–8 2024 | Hawkes MLE calibration (`scripts/calibrate_hawkes.py`), γ diagnostic |
| Week 2 — Mar 10–14 2024 | Walk-forward out-of-sample backtest |

### Fill Model Rules

1. **Strict event order** — process MBO records exactly as replayed. No lookahead.
2. **Conservative FIFO fills** — our order fills only when its level is swept AND `shares_ahead == 0`.
3. **Never fill on mid touch** — price must actually cross our limit level via a `'T'` or `'F'` action.

### Evaluation Metrics

| Metric | Target |
|--------|--------|
| Daily Sharpe (annualized) | > 2.0 |
| Fill rate (passive) | > 55% |
| Adverse selection cost | < 50% of quoted half-spread |
| Spread capture ratio | > 65% of theoretical |
| Time-weighted avg \|inventory\| | < 30% of MAX_INV |
| All branching ratios | < 1.0 |

---

## 8. GUI Dashboard

A React + TypeScript dashboard for visualizing backtest results and model internals, including interactive 3D surfaces for the Hawkes and kinetic fill models.

### Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + TypeScript + Vite |
| 2D Charts | Recharts (time series, histograms, area charts) |
| 3D Charts | Plotly.js via `react-plotly.js` (surface plots, 3D scatter) |
| Styling | Tailwind CSS |
| Data | JSONL streamed from a local Python WebSocket bridge (`scripts/ws_bridge.py`) |
| Deploy | GitHub Pages via `gh-pages` or GitHub Actions (static build, JSONL bundled) |

### Data Flow

```
C++ Simulator (stdout JSONL) → scripts/ws_bridge.py (WebSocket server) → React dashboard (live)
                                                                        ↓
                                                            or: load saved .jsonl for replay
```

The WebSocket bridge (`ws_bridge.py`) pipes simulator stdout to port 8765 so the dashboard can consume live events during a backtest run. For static GitHub Pages deployment, the JSONL is pre-recorded and bundled.

### Simulator JSONL Log Format

```jsonc
{"t":1709559000000000000,"type":"book","mid":420500000000,"spread":100000000,"bid_qty":3200,"ask_qty":2800}
{"t":1709559000000000050,"type":"hawkes","lam_buy":0.9955,"lam_sell":6.0535,"lam_cancel":7.9014,"imbalance":0.141}
{"t":1709559000000000100,"type":"quote","bid":420400000000,"ask":420600000000,"size":100}
{"t":1709559000000001200,"type":"pnl","realized":50000000,"unrealized":-20000000,"inventory":100}
```

### Dashboard Pages

#### 1. PnL & Strategy Stats
The primary results page.
- Cumulative realized + unrealized PnL over the session (area chart, color-banded by sign)
- Inventory time series overlaid on PnL
- Summary stat cards: total PnL, Sharpe (annualized daily), fill rate, spread capture ratio, adverse selection cost, max drawdown, peak inventory
- Per-hour PnL bar chart to surface intraday patterns

#### 2. Order Book Replay
- Animated bid/ask depth ladder (top 5 levels), our resting quotes highlighted in a distinct color
- Event scrubber to seek to any timestamp
- TOB spread over time (line chart beneath the ladder)

#### 3. Hawkes Intensity — 2D + 3D
- **2D panel:** λ_buy(t), λ_sell(t), λ_cancel(t) time series with fill/cancel event rug plot
- **3D panel (Plotly surface):** Phase-space trajectory `(λ_buy, λ_sell, λ_cancel)` as a 3D line trace, colored by flow imbalance. Shows how buy/sell intensity co-evolve and where the system spends most of its time relative to the steady-state point `(E[λ_buy], E[λ_sell], E[λ_cancel])`
- Branching ratio and stationarity indicators; alert highlight when sell λ approaches near-critical zone

#### 4. Kinetic Fill Model — 3D Surface
- **3D surface (Plotly):** `P(fill | frac, log Q)` rendered as a surface over the `(frac, log Q)` grid using the fitted `(β₀, β₁, β₂, β₃)` parameters. X-axis = queue fraction, Y-axis = log(total queue depth), Z-axis = fill probability
- Scatter overlay of actual fills and cancels from the backtest (color-coded) plotted on the surface to show model fit
- Sliders to interactively explore how the surface changes with different beta values

#### 5. Fill Analytics
- Fill rate by frac bucket and Q bucket (heatmap matching `gamma_fit.png`)
- Adverse selection histogram: distribution of mid-price move in the 1s after our fill
- Spread capture ratio over the session

---

## 9. Dev Roadmap

### Phase 1 — Foundation ✓ DONE
- `DatabentoAdapter`: `MboMsg` → `OrderEvent`
- L3 order book with FIFO queue tracking (`OrderBook`, `Level`)
- Nanodollar price utilities + session filter
- Logger (JSONL)
- Catch2 unit test harness

### Phase 2 — Data & Calibration ✓ DONE
- `data/MSFT_20240303_20240314_mbo.dbn` pulled (Mar 3–14 2024)
- Session-filtered parquet cache (54M rows, loads in 0.8s)
- `scripts/calibrate_hawkes.py` → `configs/MSFT.json` (Ozaki MLE, numba JIT, 12 restarts)
- All three processes stationary; sell branching ratio 0.911 (near-critical)

### Phase 3 — Models ✓ DONE
- `HawkesProcess` / `HawkesTriple` with recursive O(1) update
- `KineticQueue` — logistic fill model `P = sigmoid(β₀ + β₁·frac + β₂·log(Q) + β₃·frac·log(Q))`; betas fitted by `scripts/fit_gamma.py` on 2024-03-04 ITCH data (β₀=4.21, β₁=−4.15, β₂=−2.27, β₃=1.98)
- `InventoryManager`: A-S reservation price, EWMA σ², inventory tracking, PnL, spread skew
- Config loading from `configs/MSFT.json` via nlohmann/json
- 86 Catch2 assertions passing

### Phase 4 — Strategy + Simulator ← NEXT
- `MarketMaker.hpp`: full quoting decision wiring Hawkes + KineticQueue + InventoryManager
- `RiskGate.hpp`: hard inventory, loss, and stale-book limits
- Synthetic order injection (track our own orders through the book replay)
- Fill matching against our actual resting orders (not all market fills)
- Session-aware halt/clear event handling

### Phase 5 — Backtest + GUI
- Walk-forward evaluation on Week 2 (Mar 10–14); parameter sweeps (`gamma_as`, `k_hawkes`, `base_spread`, `max_inventory`)
- Sharpe analysis, adverse selection decomposition, per-hour Hawkes intensity (non-stationarity check)
- React + Vite + Tailwind + Plotly.js dashboard (see §8 for full spec):
  - **PnL & Stats** — cumulative PnL, Sharpe, fill rate, spread capture, adverse selection stat cards
  - **Order Book Replay** — animated depth ladder with our quotes, event scrubber
  - **Hawkes 3D** — phase-space trajectory `(λ_buy, λ_sell, λ_cancel)` as a 3D line trace; 2D intensity time series with event rug plot
  - **Kinetic Fill Surface** — interactive 3D `P(frac, log Q)` surface with actual fill/cancel scatter overlay and beta sliders
  - **Fill Analytics** — fill rate heatmap, adverse selection histogram, spread capture over session
- WebSocket bridge (`scripts/ws_bridge.py`) for live streaming during backtest run
- Static JSONL bundle for GitHub Pages deployment

---

## 10. Resolved Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data source | **Databento XNAS.ITCH** | $125 free credit, C++ client, multi-week history, true L3 MBO schema |
| Hawkes model | **3 independent processes** | Reliable calibration on limited data; captures buy/sell/cancel intensity separately |
| Hawkes calibration | **Ozaki MLE, numba JIT, 12 restarts** | 67× speedup over pure Python; L-BFGS-B with stationarity constraint |
| Cancel subsampling | **1/15** | 13.7M → 915k events; MLE is consistent under uniform subsampling |
| Fill model | **FIFO** | Standard Nasdaq matching; conservative and accurate for backtest |
| Session | **09:30–16:00 ET; skip `'R'` / halt events** | Different microstructure dynamics outside regular session |
| Instrument | **MSFT** | Liquid, available in Databento with multi-year history |
| Price encoding | **`int64_t` nanodollars** | No float precision bugs; matches Databento API directly |
| Fill probability model | **Logistic on (frac, log Q):** `P = sigmoid(β₀ + β₁·frac + β₂·logQ + β₃·frac·logQ)` | Power-law `P=1−(q/Q)^γ` mis-specified: empirical fill rate increases with Q (active-level proxy), not frac. Logistic model conditions on both; `β₂ > 0` captures activity effect; `β₃` interaction allows slope to vary with level size. Fitted by `scripts/fit_gamma.py` via sklearn logistic regression on fill/cancel events. |
| Volatility estimate | **EWMA of (ΔS)²/Δt in nanodollar²/s** | Keeps A-S arithmetic in native price units; no unit conversion needed |
| JSON loading | **nlohmann/json (bundled with databento-cpp)** | Zero extra dependencies; already in build graph |

---

## 11. Open Questions

- **MarketMaker threshold tuning:** Optimal `lambda_halt`, `min_fill_prob`, `k_hawkes`, `gamma_as` values — need walk-forward sweep to calibrate.
- **Sell near-critical branching ratio (0.911):** Does this imply regime-dependent calibration (open/close vs midday)? Recalibration every N events is planned but N is unknown.
- **Multi-level quoting:** Quote at TOB only, or also second level? More fills vs more complexity.
- **Latency simulation:** Does a 50µs simulated latency materially change fill model results?
- **Fill model beta interpretation:** β₂ = −2.27 (negative — larger queue lowers fill probability conditional on frac). The interaction β₃ = +1.98 causes the net frac slope `β₁ + β₃·log(Q)` to become positive for Q > ~8 shares, capturing the empirical pattern where back-of-queue orders on real-world levels fill more often. Worth revisiting whether a survival-bias correction changes the sign of β₂.

---

## 12. References

- Hawkes, A.G. (1971) — *Spectra of some self-exciting and mutually exciting point processes*
- Bacry, Mastromatteo & Muzy (2015) — *Hawkes processes in finance* (review paper)
- Cont, Stoikov & Talreja (2010) — *A stochastic model for order book dynamics*
- Avellaneda & Stoikov (2008) — *High-frequency trading in a limit order book*
- Huang, Rosenbaum & Saliba (2015) — *A queue-reactive model for order flow*
- Ozaki (1979) — *Maximum likelihood estimation of Hawkes' self-exciting point processes*
- Databento documentation — [databento.com/docs](https://databento.com/docs)
- Databento C++ client — [github.com/databento/databento-cpp](https://github.com/databento/databento-cpp)

---

*hawkes-hft · framework v0.4 · MSFT · Databento XNAS.ITCH MBO · C++20*
