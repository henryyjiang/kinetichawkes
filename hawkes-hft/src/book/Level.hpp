#pragma once
#include <cstdint>
#include <map>

struct Level {
    int64_t price          = 0;
    int64_t total_quantity = 0;
    // shares_ahead: external agents (e.g. KineticQueue tests) may set this to
    // represent the queue position for fill-probability calculations.  The order
    // book itself does not manage this field; use SyntheticOrder::shares_ahead
    // inside MarketMaker for live FIFO tracking.
    int64_t shares_ahead   = 0;

    std::map<uint64_t, int32_t> orders;

    void add_order(uint64_t order_id, int32_t size) {
        orders[order_id]  = size;
        total_quantity   += size;
    }

    // Returns true when the order is fully consumed (size reaches 0).
    bool cancel_order(uint64_t order_id, int32_t cancelled_size) {
        auto it = orders.find(order_id);
        if (it == orders.end()) return false;
        total_quantity -= cancelled_size;
        it->second -= cancelled_size;
        if (it->second <= 0) {
            orders.erase(it);
            return true;
        }
        return false;
    }

    void on_trade(uint64_t order_id, int32_t executed_size) {
        total_quantity -= executed_size;
        orders.erase(order_id);
    }

    bool empty() const { return total_quantity <= 0; }
};
