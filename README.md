# KineticHawkes

A high-frequency market-making simulator for MSFT built on L3 order-book data. Three calibrated Hawkes processes model buy, sell, and cancel arrival intensities; a logistic-regression queue model estimates fill probability; and an Avellaneda–Stoikov reservation-price framework manages inventory risk. The strategy is replayed against ~54 M nanosecond-stamped events across a 9-day live Nasdaq ITCH tape.

**[Live demo →](https://henryyjiang.github.io/kinetichawkes/)**

---

## Results (9-day MSFT replay, Mar 4–14 2024)

| Metric | Value |
|---|---|
| Total PnL | +$1,586 |
| Sharpe ratio | 6.81 |
| Fills | 149 (80 bid / 69 ask) |
| Ending inventory | 28 shares |
| Sessions halted | 0 |

---

## Architecture

```
Databento MBO feed (.dbn)
        │
        ▼
DatabentoAdapter        convert raw msgs → OrderEvent structs
        │
        ▼
OrderBook               reconstruct full L3 book (price→Level maps)
        │
        ├──► HawkesTriple     track λ_buy(t), λ_sell(t), λ_cancel(t)
        │
        ├──► KineticQueue     estimate P(fill | queue position, depth)
        │
        ├──► InventoryManager A-S reservation price + EWMA volatility
        │
        ├──► MarketMaker      synthetic bid/ask placement and FIFO tracking
        │
        └──► RiskGate         hard limits: daily loss, max inventory, stale feed
                │
                ▼
           Logger → stdout (JSONL snapshots) → gui/public/sim_data.jsonl
```

The C++ simulator is a single-pass event replay: every MBO message updates the book, fires the relevant Hawkes process, then conditionally requotes. Snapshots are emitted every N session events (default 10 000) as newline-delimited JSON consumed by the React dashboard.

---

## Mathematical Models

### Hawkes Processes

Three independent univariate Hawkes processes track market order and cancel arrival intensities:

```
λ(t) = μ + Σ α · exp(−β · (t − tᵢ))   for all past events tᵢ < t
```

Each event decays the current intensity exponentially with rate β, then adds a jump α on arrival. The branching ratio α/β < 1 ensures stationarity. Separate processes are calibrated for buy MOs, sell MOs, and cancels.

The spread widens proportionally to excess total MO intensity:

```
half_spread = base_spread/2 + k_hawkes · max(0, λ_buy + λ_sell − λ_baseline)
```

Flow imbalance λ_buy / (λ_buy + λ_sell) feeds the 3-D Hawkes visualisation in the GUI.

### Kinetic Queue Fill Model

Fill probability for a resting order at queue position q in a level of total depth Q is estimated by logistic regression fit to one week of MSFT tape:

```
P(fill | q, Q) = sigmoid(β₀ + β₁·(q/Q) + β₂·log(Q) + β₃·(q/Q)·log(Q))
```

Calibrated coefficients (MSFT, 2024-03-04):

| Param | Value | Interpretation |
|---|---|---|
| β₀ | +4.213 | base fill rate |
| β₁ | −4.153 | deeper in queue → lower P |
| β₂ | −2.269 | larger level → lower P (more competition) |
| β₃ | +1.982 | interaction: depth effect softens at back |

An order is only placed if P(fill) ≥ `min_fill_prob` (default 0.001). The model is trained on 51 864 fills and 1 569 820 cancels.

### Avellaneda–Stoikov Reservation Price

The strategy skews quotes symmetrically around a reservation price that penalises holding inventory as time to close approaches:

```
r(s, q, t) = s − q · γ · σ² · (T − t)
```

- `s` = current mid-price  
- `q` = signed inventory in shares  
- `γ` = risk-aversion coefficient (calibrated to 0.05)  
- `σ²` = EWMA of (ΔS)²/Δt, warm-started at 1.5 × 10⁻³ USD²/s (realistic MSFT intraday vol²)  
- `T − t` = seconds remaining until session close (16:00 ET)

The bid is placed at `r − half_spread` and the ask at `r + half_spread`. One side is suppressed once inventory exceeds 40% of the hard limit (60 shares), preventing the strategy from adding to a large directional position.

### Risk Gate

Hard limits checked before every quoting decision:

| Limit | Value | Action |
|---|---|---|
| Daily loss | $5 | Permanent halt |
| Max inventory | ±150 shares | Cancel both quotes |
| MO intensity | λ > 20 ev/s | Cancel both quotes |
| Stale feed | > 100 ms since last event | Cancel both quotes |
| Pre-close | < 5 min to 16:00 ET | Cancel both quotes |

---

## Repository Layout

```
kinetichawkes/
├── hawkes-hft/               C++ simulator (CMake, C++20)
│   ├── src/
│   │   ├── book/             OrderBook, Level
│   │   ├── feed/             DatabentoAdapter, OrderEvent
│   │   ├── models/           HawkesProcess, HawkesTriple, KineticQueue
│   │   ├── strategy/         InventoryManager, MarketMaker
│   │   ├── risk/             RiskGate
│   │   ├── sim/              Simulator (main replay loop)
│   │   └── main.cpp          CLI entry point
│   ├── tests/                Catch2 unit tests
│   └── CMakeLists.txt
├── gui/                      Vite + React dashboard
│   ├── src/
│   │   ├── App.tsx           Main layout, sliders, charts
│   │   ├── components/       Plot3D (kinetic surface), HawkesSpike3D
│   │   ├── data.ts           JSONL parser, stat helpers
│   │   └── types.ts          Shared TypeScript types
│   └── public/
│       └── sim_data.jsonl    Pre-computed 9-day replay (1.9 MB)
├── configs/
│   └── MSFT.json             Hawkes params, kinetic betas, strategy settings
├── scripts/
│   ├── calibrate_hawkes.py   MLE calibration (scipy + numba)
│   └── fit_gamma.py          Logistic regression for KineticQueue
├── data_scripts/
│   ├── pull_data.py          Databento API download
│   ├── check_costs.py        Quote data cost before pulling
│   └── inspect_data.py       DBN schema inspection
└── .github/workflows/
    └── deploy.yml            GitHub Actions → GitHub Pages
```

---

## Building the C++ Simulator

**Dependencies:** CMake ≥ 3.24, C++20 compiler, OpenSSL, zstd.  
The Databento C++ client and nlohmann/json are fetched automatically via `FetchContent`.

```bash
# macOS
brew install cmake openssl zstd

# Ubuntu / Debian
apt install cmake libssl-dev libzstd-dev

# Configure and build
cmake -S hawkes-hft -B hawkes-hft/build -DCMAKE_BUILD_TYPE=Release
cmake --build hawkes-hft/build -j$(nproc)
```

Run the tests:

```bash
cd hawkes-hft/build && ctest --output-on-failure
```

---

## Running the Simulator

```bash
./hawkes-hft/build/hawkes-hft <path-to.dbn> <path-to-config.json> [log_interval]
```

The binary writes JSONL snapshots to stdout and progress/stats to stderr.

**Full 9-day replay:**

```bash
./hawkes-hft/build/hawkes-hft \
    data/MSFT_20240303_20240314_mbo.dbn \
    configs/MSFT.json \
    > gui/public/sim_data.jsonl
```

`log_interval` controls how often a snapshot is emitted (default: every 10 000 session events). Lower values produce finer-grained charts at the cost of a larger output file.

---

## Calibration

Hawkes parameters and kinetic queue coefficients are calibrated from Week 1 of the tape (Mar 4–8 2024) and held fixed for the Week 2 out-of-sample replay.

**Hawkes MLE** (scipy L-BFGS-B, Numba-compiled log-likelihood):

```bash
pip install numpy pandas scipy numba databento
python scripts/calibrate_hawkes.py
# writes mu/alpha/beta + branching ratio into configs/MSFT.json
```

**Kinetic queue logistic regression** (sklearn):

```bash
python scripts/fit_gamma.py
# writes beta0–beta3 into configs/MSFT.json, saves gamma_fit.png
```

Calibrated Hawkes parameters (MSFT):

| Process | μ (ev/s) | α | β | Branching ratio |
|---|---|---|---|---|
| Buy MO | 0.498 | 928 | 1857 | 0.500 |
| Sell MO | 0.539 | 3247 | 3565 | 0.911 |
| Cancel | 3.781 | 35.3 | 67.7 | 0.521 |

---

## Data

Market data is Databento `XNAS.ITCH` MBO schema — nanosecond-stamped L3 order events (add, cancel, fill, clear) for MSFT.

**Acquiring your own data:**

```bash
# 1. Sign up at databento.com ($125 free credit, no card required)
# 2. Set your API key
export DATABENTO_API_KEY=your_key_here

# 3. Check cost before pulling
python data_scripts/check_costs.py

# 4. Pull
python data_scripts/pull_data.py
```

The `.dbn` file (~770 MB) is excluded from version control (`.gitignore`). The pre-computed `gui/public/sim_data.jsonl` is committed so the GitHub Pages demo works without it.

---

## GUI Dashboard

The React dashboard visualises the full replay: PnL curve, inventory, bid/ask spread, Hawkes intensities, fill log, and the 3-D kinetic fill-probability surface.

**Local dev (live re-simulation):**

```bash
cd gui && npm install && npm run dev
```

The dev server exposes `/api/run` — a middleware that spawns the C++ binary, streams output to `public/sim_data.jsonl`, and polls the file live. Parameter sliders in the UI POST a config object to this endpoint and the charts update in real time.

**Static build:**

```bash
cd gui && npm run build   # output → gui/dist/
```

The GitHub Pages deployment runs this automatically on every push to `main` (see `.github/workflows/deploy.yml`). The deployed site shows the pre-computed replay; live re-simulation requires the local C++ binary.

---

## Strategy Parameters

All parameters are in `configs/MSFT.json` under the `"strategy"` key and can be overridden without recompiling:

| Parameter | Default | Description |
|---|---|---|
| `gamma_as` | 0.05 | A-S risk aversion — controls how aggressively quotes skew with inventory |
| `base_spread` | 10 000 000 | Base full spread in nanodollars ($0.01) |
| `k_hawkes` | 1 000 000 | Nanodollars of extra half-spread per ev/s excess MO intensity |
| `max_half_spread` | 200 000 000 | Hard cap on half-spread ($0.20) |
| `max_inventory` | 150 | Hard inventory limit in shares |
| `inv_one_side_frac` | 0.40 | One-side suppression threshold as fraction of max_inventory |
| `min_fill_prob` | 0.001 | Minimum kinetic fill probability to place an order |
| `default_size` | 100 | Shares per quote |

---

## References

- Avellaneda, M. & Stoikov, S. (2008). *High-frequency trading in a limit order book.* Quantitative Finance.
- Hawkes, A. G. (1971). *Spectra of some self-exciting and mutually exciting point processes.* Biometrika.
- Cont, R. & de Larrard, A. (2013). *Price dynamics in a Markovian limit order market.* SIAM J. Financial Mathematics.
- [Databento XNAS.ITCH documentation](https://databento.com/docs/schemas-and-data-formats/whats-mbo)
- [databento-cpp](https://github.com/databento/databento-cpp)
