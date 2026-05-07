#pragma once
#include "book/OrderBook.hpp"
#include "models/HawkesTriple.hpp"
#include "models/KineticQueue.hpp"
#include "strategy/InventoryManager.hpp"
#include "risk/RiskGate.hpp"
#include <cstdint>
#include <cmath>
#include <algorithm>

// A single synthetic resting order (bid or ask) tracked through the replay.
struct SyntheticOrder {
    int64_t price        = 0;
    int32_t size         = 0;
    int64_t shares_ahead = 0;   // shares in front of ours in FIFO queue
    bool    active       = false;
    int8_t  side         = 0;   // +1 = bid, -1 = ask
};

// Returned by check_our_fill when our order executes.
struct FillResult {
    bool    filled     = false;
    int32_t fill_size  = 0;
    int64_t fill_price = 0;
    int8_t  side       = 0;   // +1 = we bought (bid filled), -1 = we sold (ask filled)
};

// Manages the strategy's two resting synthetic orders (one bid, one ask).
//
// Queue mechanics: on placement, shares_ahead = all existing quantity at that
// price level.  Subsequent cancel and fill events at the same level drain
// shares_ahead in FIFO order.  Our order executes when shares_ahead reaches
// zero and the fill event has size remaining that reaches us.
struct MarketMaker {
    SyntheticOrder my_bid;
    SyntheticOrder my_ask;

    double  min_fill_prob      = 0.001;          // kinetic gate — betas give <0.05 at inside ask depth
    int32_t default_size       = 100;            // shares per quote
    int64_t tick_size          = 10'000'000LL;   // $0.01 in nanodollars (MSFT penny tick)
    double  inv_one_side_frac  = 0.40;           // suppress adding side when |inv| > frac * max_inv

    // -------------------------------------------------------------------
    // Queue tracking — call these BEFORE checking our own fill

    // A cancel event freed up space in our queue.
    void on_cancel_at_level(int64_t price, int8_t passive_side, int64_t cancelled_size) {
        SyntheticOrder* ord = find_order(price, passive_side);
        if (!ord) return;
        ord->shares_ahead = std::max(0LL, ord->shares_ahead - cancelled_size);
    }

    // A fill event at our level; checks whether it reaches and executes our order.
    //
    // passive_side: side of the resting (passive) order being consumed.
    //   +1 = bid being filled (sell MO hit our bid)
    //   -1 = ask being filled (buy MO hit our ask)
    //
    // Logic: the first `shares_ahead` shares of the fill go to orders ahead of us.
    // Any remainder reaches us.  Partial fills are supported: size is decremented
    // and the order stays active until fully consumed.
    FillResult check_our_fill(int64_t price, int8_t passive_side, int64_t fill_size) {
        SyntheticOrder* ord = find_order(price, passive_side);
        if (!ord) return {};

        int64_t old_ahead = ord->shares_ahead;
        ord->shares_ahead = std::max(0LL, old_ahead - fill_size);

        // Did the fill reach past our queue position?
        int64_t reached_us = fill_size - old_ahead;
        if (reached_us <= 0) return {};

        int32_t exec = static_cast<int32_t>(
            std::min(static_cast<int64_t>(ord->size), reached_us));
        if (exec <= 0) return {};

        ord->size -= exec;
        if (ord->size <= 0) ord->active = false;
        return {true, exec, price, passive_side};
    }

    // -------------------------------------------------------------------
    // Quoting decisions

    // Recompute target quotes, update resting orders if they need to move.
    // Returns true if any order was placed, cancelled, or replaced.
    //
    // The full quoting decision pipeline:
    //   1. RiskGate check  → halt or cancel-all if limits breached
    //   2. InventoryManager::compute_quotes  → target bid/ask prices with A-S skew
    //   3. KineticQueue P_fill gate  → skip levels where fill probability is too low
    //   4. Tick-round targets and requote only if price changed
    bool update_quotes(int64_t t_ns, const OrderBook& book,
                       const HawkesTriple& hawkes, const KineticQueue& kinetic,
                       const InventoryManager& inv, RiskGate& gate) {
        auto tob = book.effective_tob();
        int64_t mid = tob.valid ? (tob.bid + tob.ask) / 2 : 0;

        auto action = gate.check(t_ns, inv.inventory,
                                 mid > 0 ? inv.total_pnl(mid) : inv.cash,
                                 hawkes.total_mo_intensity(), false);

        if (action == RiskGate::Action::HaltSession) {
            bool any = my_bid.active || my_ask.active;
            cancel_all();
            return any;
        }
        if (action == RiskGate::Action::CancelQuotes) {
            bool any = my_bid.active || my_ask.active;
            cancel_all();
            return any;
        }

        if (!tob.valid || mid == 0) return false;

        auto target = inv.compute_quotes(mid, t_ns, hawkes.total_mo_intensity());
        if (!target.valid) {
            bool any = my_bid.active || my_ask.active;
            cancel_all();
            return any;
        }

        // Round bid down and ask up to tick grid
        int64_t tbid = round_down(target.bid_px);
        int64_t task = round_up(target.ask_px);

        // Clamp each side independently to stay inside the spread.
        // A-S skew can push the bid above tob.ask (urgent buy) or ask below
        // tob.bid (urgent sell) — clamping keeps us passive but as aggressive
        // as possible, rather than cancelling both quotes outright.
        tbid = std::min(tbid, tob.ask - tick_size);
        task = std::max(task, tob.bid + tick_size);

        // If spread has collapsed (tob.ask - tob.bid < 2 ticks), stay out
        if (tbid >= task) {
            bool any = my_bid.active || my_ask.active;
            cancel_all();
            return any;
        }

        // Inventory side-suppression: once we accumulate a position exceeding
        // inv_one_side_frac of max, stop adding to it and only quote the
        // side that reduces inventory.
        int32_t one_side_thresh =
            static_cast<int32_t>(inv.max_inventory * inv_one_side_frac);
        bool suppress_bid = inv.inventory > +one_side_thresh;  // long → only ask
        bool suppress_ask = inv.inventory < -one_side_thresh;  // short → only bid

        if (suppress_bid && my_bid.active) { my_bid.active = false; }
        if (suppress_ask && my_ask.active) { my_ask.active = false; }

        bool changed = false;
        if (!suppress_bid) changed |= maybe_requote(my_bid, tbid,  1, book, kinetic);
        if (!suppress_ask) changed |= maybe_requote(my_ask, task, -1, book, kinetic);
        return changed;
    }

    void cancel_all() {
        my_bid.active = false;
        my_ask.active = false;
    }

    bool any_active() const { return my_bid.active || my_ask.active; }

private:
    // Returns a pointer to our order if we have one resting at (price, side).
    SyntheticOrder* find_order(int64_t price, int8_t side) {
        if (side ==  1 && my_bid.active && my_bid.price == price) return &my_bid;
        if (side == -1 && my_ask.active && my_ask.price == price) return &my_ask;
        return nullptr;
    }

    int64_t round_down(int64_t px) const {
        return (px / tick_size) * tick_size;
    }
    int64_t round_up(int64_t px) const {
        return ((px + tick_size - 1) / tick_size) * tick_size;
    }

    // Current quantity resting at a given price level in the book.
    int64_t level_qty(const OrderBook& book, int64_t price, int8_t side) const {
        if (side == 1) {
            auto it = book.bids.find(price);
            return it != book.bids.end() ? it->second.total_quantity : 0;
        } else {
            auto it = book.asks.find(price);
            return it != book.asks.end() ? it->second.total_quantity : 0;
        }
    }

    // Decide whether to place / replace the given order slot at target_px.
    // Cancels the existing order if price changed, then places only if
    // KineticQueue fill probability clears the minimum threshold.
    bool maybe_requote(SyntheticOrder& ord, int64_t target_px, int8_t side,
                       const OrderBook& book, const KineticQueue& kinetic) {
        if (ord.active && ord.price == target_px) return false;

        bool had_order = ord.active;
        ord.active = false;   // cancel any existing

        int64_t Q_exist    = level_qty(book, target_px, side);
        int64_t ahead      = Q_exist;                       // we join back of queue
        int64_t Q_total    = Q_exist + default_size;
        double  p          = kinetic.fill_prob(ahead, Q_total);

        if (p < min_fill_prob) return had_order;   // not worth it; old cancel counts as change

        ord.price        = target_px;
        ord.size         = default_size;
        ord.side         = side;
        ord.shares_ahead = ahead;
        ord.active       = true;
        return true;
    }
};
