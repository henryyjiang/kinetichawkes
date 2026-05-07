#pragma once
#include "HawkesProcess.hpp"

struct HawkesTriple {
    HawkesProcess buy;
    HawkesProcess sell;
    HawkesProcess cancel;

    HawkesTriple() = default;
    HawkesTriple(HawkesProcess b, HawkesProcess s, HawkesProcess c)
        : buy(b), sell(s), cancel(c) {}

    // Decay all three before firing to avoid double-decay on the fired process.
    // event_type: 0=buy, 1=sell, 2=cancel, -1=other
    void update(int64_t t_ns, int event_type) {
        buy.decay(t_ns);
        sell.decay(t_ns);
        cancel.decay(t_ns);
        if      (event_type == 0) buy.fire(t_ns);
        else if (event_type == 1) sell.fire(t_ns);
        else if (event_type == 2) cancel.fire(t_ns);
    }

    double flow_imbalance() const {
        double total = buy.lambda_cur + sell.lambda_cur;
        return total > 0.0 ? buy.lambda_cur / total : 0.5;
    }

    double total_mo_intensity() const {
        return buy.lambda_cur + sell.lambda_cur;
    }

    void reset(int64_t t_ns) {
        buy.reset(t_ns);
        sell.reset(t_ns);
        cancel.reset(t_ns);
    }
};
