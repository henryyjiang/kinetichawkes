#pragma once
#include <cstdint>
#include <cmath>
#include <algorithm>

struct QuoteSkew {
    int64_t bid_px = 0;
    int64_t ask_px = 0;
    bool    valid  = false;
};

// Avellaneda-Stoikov reservation price and inventory tracking.
//
// r(s,q,t) = s − q · γ_as · σ² · (T−t)
//
// σ² is estimated as an EWMA of (ΔS)²/Δt in nanodollar²/s, updated on every
// mid-price change. This keeps all arithmetic in the same nanodollar units as
// the order book so nothing ever converts to doubles for quote placement.
struct InventoryManager {
    // A-S risk-aversion in USD-space.  skew_usd = inventory * gamma * sigma_sq * T_rem.
    // With sigma_sq ~1.5e-3 USD²/s (MSFT realistic intraday vol²) and gamma=5e-2:
    //   at -60 sh (one-side threshold), T_rem=2h: skew ≈ 60 * 5e-2 * 1.5e-3 * 7200 ≈ $32
    // The A-S skew decays as sigma_sq is estimated; calibrated for MSFT 9-day replay.
    double  gamma_as      = 5e-2;
    // $0.01 spread — at the tight end of MSFT $0.01–0.02 quoted spread
    int64_t base_spread   = 10'000'000;    // $0.01 in nanodollars
    // $0.001 of extra half-spread per ev/s excess MO intensity
    double  k_hawkes      = 1'000'000.0;
    int64_t max_half_spread = 200'000'000; // $0.20 cap — prevent cancel-spike blowouts
    double  baseline_mo   = 1.0;           // steady-state total MO intensity (ev/s)
    int32_t max_inventory = 150;           // hard cap; one-side threshold = 60 sh
    int64_t session_close_ns = 0;          // UTC ns; caller must set before run

    int32_t inventory  = 0;
    int64_t cash       = 0;               // running cash: −price×size on buys, +price×size on sells

    // EWMA variance in USD²/s (price delta in USD squared, divided by dt in seconds)
    // Warm-start = MSFT typical intraday vol²/s: σ_day≈$5, T_day=23400s → σ²/s≈0.00107
    double  sigma_sq    = 1.5e-3;
    double  ewma_alpha  = 0.01;
    int64_t prev_mid_ns = 0;
    int64_t prev_mid_px = 0;

    void update_vol(int64_t t_ns, int64_t mid_px) {
        if (prev_mid_ns > 0 && prev_mid_px > 0) {
            double dt = (t_ns - prev_mid_ns) * 1e-9;
            if (dt > 1e-6) {
                // Convert nanodollar delta to USD before squaring to keep sigma_sq in USD²/s
                double delta_usd = static_cast<double>(mid_px - prev_mid_px) * 1e-9;
                double sample = (delta_usd * delta_usd) / dt;
                sigma_sq = ewma_alpha * sample + (1.0 - ewma_alpha) * sigma_sq;
            }
        }
        prev_mid_ns = t_ns;
        prev_mid_px = mid_px;
    }

    // side: +1 = bid filled (we bought), -1 = ask filled (we sold)
    void on_fill(int8_t side, int64_t price, int32_t size) {
        inventory += side * size;
        cash      -= static_cast<int64_t>(side) * price * size;
    }

    int64_t reservation_price(int64_t mid_px, int64_t t_ns) const {
        double T_rem    = std::max(0.0, (session_close_ns - t_ns) * 1e-9);
        double mid_usd  = static_cast<double>(mid_px) * 1e-9;
        // skew in USD; sigma_sq is already in USD²/s
        double skew_usd = static_cast<double>(inventory) * gamma_as * sigma_sq * T_rem;
        return static_cast<int64_t>((mid_usd - skew_usd) * 1e9);
    }

    // total_pnl = cash + mark-to-market inventory value
    int64_t total_pnl(int64_t mid_px) const {
        return cash + static_cast<int64_t>(static_cast<double>(inventory) * mid_px);
    }

    QuoteSkew compute_quotes(int64_t mid_px, int64_t t_ns, double total_mo) const {
        double T_rem = (session_close_ns - t_ns) * 1e-9;
        // Stop quoting 30 min before close (was 5 min) to allow inventory to drain.
        // Hard max_inventory guard is handled by one-sided quoting in MarketMaker.
        if (T_rem < 1800.0 || std::abs(inventory) >= max_inventory)
            return {};

        int64_t r = reservation_price(mid_px, t_ns);

        // Spread widens with excess MO intensity; capped to prevent cancel-spike blowouts
        double  excess   = std::max(0.0, total_mo - baseline_mo);
        int64_t half_spr = base_spread / 2 + static_cast<int64_t>(k_hawkes * excess);
        half_spr = std::min(half_spr, max_half_spread);

        return {r - half_spr, r + half_spr, true};
    }
};
