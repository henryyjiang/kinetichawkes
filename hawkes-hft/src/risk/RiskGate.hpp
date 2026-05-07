#pragma once
#include <cstdint>
#include <cmath>
#include <algorithm>

// Hard risk limits evaluated before every quoting decision.
//
// check() is non-const: it sets halted=true on a daily-loss breach so the
// caller doesn't have to remember to do it.  All other CancelQuotes triggers
// are transient — quoting resumes once the condition clears.
struct RiskGate {
    int32_t max_inventory    = 150;   // must match InventoryManager::max_inventory
    int64_t max_daily_loss   = 5'000'000'000LL;   // $5 in nanodollars
    double  lambda_halt      = 20.0;               // total MO intensity threshold
    int64_t stale_timeout_ns = 100'000'000LL;      // 100 ms
    int64_t pre_close_secs   = 300;                // cancel quotes this many seconds before close

    bool    halted           = false;
    int64_t last_event_ns    = 0;
    int64_t session_close_ns = 0;
    int64_t session_open_pnl = 0;   // PnL at the start of this session for daily loss calc

    enum class Action { Allow, CancelQuotes, HaltSession };

    // Update the "last seen event" timestamp.  Call on every in-session event.
    void on_event(int64_t t_ns) { last_event_ns = t_ns; }

    // Reset per-day state: open PnL reference, unset halted flag, reset stale timer.
    void reset_for_session(int64_t t_ns, int64_t open_pnl) {
        session_open_pnl = open_pnl;
        last_event_ns    = t_ns;
        halted           = false;
    }

    Action check(int64_t t_ns, int32_t inventory, int64_t total_pnl,
                 double total_mo, bool is_clear) {
        if (halted)
            return Action::HaltSession;

        // Permanent halt: daily loss limit breached
        if (total_pnl - session_open_pnl < -max_daily_loss) {
            halted = true;
            return Action::HaltSession;
        }

        // Transient cancels — quotes resume once condition clears
        if (std::abs(inventory) >= max_inventory)
            return Action::CancelQuotes;

        if (is_clear)
            return Action::CancelQuotes;

        if (total_mo > lambda_halt)
            return Action::CancelQuotes;

        if (last_event_ns > 0 && (t_ns - last_event_ns) > stale_timeout_ns)
            return Action::CancelQuotes;

        if (session_close_ns > 0) {
            double T_rem = (session_close_ns - t_ns) * 1e-9;
            if (T_rem < static_cast<double>(pre_close_secs))
                return Action::CancelQuotes;
        }

        return Action::Allow;
    }
};
