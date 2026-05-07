#pragma once
#include "Level.hpp"
#include "feed/OrderEvent.hpp"
#include <map>
#include <unordered_map>
#include <functional>

struct OrderBook {
    std::map<int64_t, Level, std::greater<int64_t>> bids;
    std::map<int64_t, Level>                         asks;

    struct OrderMeta { int64_t price; int8_t side; };
    std::unordered_map<uint64_t, OrderMeta> order_index;

    int64_t mid_price() const {
        if (bids.empty() || asks.empty()) return 0;
        return (bids.begin()->first + asks.begin()->first) / 2;
    }

    int64_t spread() const {
        if (bids.empty() || asks.empty()) return 0;
        return asks.begin()->first - bids.begin()->first;
    }

    int64_t best_bid() const { return bids.empty() ? 0 : bids.begin()->first; }
    int64_t best_ask() const { return asks.empty() ? 0 : asks.begin()->first; }

    int64_t bid_depth() const {
        if (bids.empty()) return 0;
        return bids.begin()->second.total_quantity;
    }
    int64_t ask_depth() const {
        if (asks.empty()) return 0;
        return asks.begin()->second.total_quantity;
    }

    bool is_uncrossed() const { return spread() > 0; }

    // Skips persistent pre-auction ghost levels that keep the raw TOB crossed.
    struct EffectiveTOB { int64_t bid = 0; int64_t ask = 0; bool valid = false; };
    EffectiveTOB effective_tob() const {
        for (auto& [bp, bl] : bids) {
            auto ait = asks.lower_bound(bp + 1);
            if (ait == asks.end()) continue;
            return {bp, ait->first, true};
        }
        return {};
    }

    int64_t effective_mid() const {
        auto t = effective_tob();
        return t.valid ? (t.bid + t.ask) / 2 : 0;
    }

    int64_t effective_spread() const {
        auto t = effective_tob();
        return t.valid ? t.ask - t.bid : 0;
    }

    void apply(const OrderEvent& ev) {
        switch (ev.type) {
            case EventType::Clear:
                bids.clear(); asks.clear(); order_index.clear();
                break;
            case EventType::Add:    apply_add(ev);    break;
            case EventType::Cancel: apply_cancel(ev); break;
            case EventType::Modify: apply_modify(ev); break;
            case EventType::Fill:   apply_trade(ev);  break;
            case EventType::Trade:  break;  // paired Fill handles the passive side
            default:                break;
        }
    }

private:
    Level& get_or_create(int64_t price, int8_t side) {
        if (side == 1) {
            auto& lv = bids[price];
            lv.price = price;
            return lv;
        } else {
            auto& lv = asks[price];
            lv.price = price;
            return lv;
        }
    }

    void apply_add(const OrderEvent& ev) {
        if (ev.side == 0) return;
        Level& lv = get_or_create(ev.price, ev.side);
        lv.add_order(ev.order_id, ev.size);
        order_index[ev.order_id] = {ev.price, ev.side};
    }

    void apply_cancel(const OrderEvent& ev) {
        auto it = order_index.find(ev.order_id);
        if (it == order_index.end()) return;
        auto [price, side] = it->second;
        Level* lv = find_level(price, side);
        if (lv) {
            bool fully_done = lv->cancel_order(ev.order_id, ev.size);
            if (lv->empty()) remove_level(price, side);
            if (fully_done) order_index.erase(it);
        } else {
            order_index.erase(it);
        }
    }

    void apply_modify(const OrderEvent& ev) {
        // XNAS.ITCH Modify carries the NEW size, not a delta; priority is not reset on reductions.
        auto it = order_index.find(ev.order_id);
        if (it == order_index.end()) return;
        auto [price, side] = it->second;
        Level* lv = find_level(price, side);
        if (!lv) { order_index.erase(it); return; }
        auto oit = lv->orders.find(ev.order_id);
        if (oit == lv->orders.end()) { order_index.erase(it); return; }
        int32_t delta = ev.size - oit->second;
        lv->total_quantity += delta;
        oit->second = ev.size;
        if (ev.size <= 0) {
            lv->orders.erase(oit);
            if (lv->empty()) remove_level(price, side);
            order_index.erase(it);
        }
    }

    void apply_trade(const OrderEvent& ev) {
        auto it = order_index.find(ev.order_id);
        if (it == order_index.end()) return;
        auto [price, side] = it->second;
        Level* lv = find_level(price, side);
        if (lv) {
            lv->on_trade(ev.order_id, ev.size);
            if (lv->empty()) remove_level(price, side);
        }
        order_index.erase(it);
    }

    Level* find_level(int64_t price, int8_t side) {
        if (side == 1) {
            auto it = bids.find(price);
            return it != bids.end() ? &it->second : nullptr;
        } else {
            auto it = asks.find(price);
            return it != asks.end() ? &it->second : nullptr;
        }
    }

    void remove_level(int64_t price, int8_t side) {
        if (side == 1) bids.erase(price);
        else           asks.erase(price);
    }
};
