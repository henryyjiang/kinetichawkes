#pragma once
#include "book/OrderBook.hpp"
#include "models/HawkesTriple.hpp"
#include "models/KineticQueue.hpp"
#include "strategy/InventoryManager.hpp"
#include "strategy/MarketMaker.hpp"
#include "risk/RiskGate.hpp"
#include "feed/DatabentoAdapter.hpp"
#include "util/PriceUtils.hpp"
#include "util/Logger.hpp"
#include <databento/dbn_file_store.hpp>
#include <cstdint>
#include <cstdio>
#include <string>

struct SimStats {
    uint64_t total_events   = 0;
    uint64_t session_events = 0;
    uint64_t trades         = 0;
    uint64_t cancels        = 0;
    uint64_t adds           = 0;
    uint64_t our_fills      = 0;
    uint64_t our_bid_fills  = 0;
    uint64_t our_ask_fills  = 0;
    int64_t  our_fill_shrs  = 0;

    void print() const {
        fprintf(stderr, "=== Sim Stats ===\n");
        fprintf(stderr, "  Total events  : %llu\n", (unsigned long long)total_events);
        fprintf(stderr, "  Session events: %llu\n", (unsigned long long)session_events);
        fprintf(stderr, "  Trades        : %llu\n", (unsigned long long)trades);
        fprintf(stderr, "  Cancels       : %llu\n", (unsigned long long)cancels);
        fprintf(stderr, "  Adds          : %llu\n", (unsigned long long)adds);
        fprintf(stderr, "  Our fills     : %llu (%llu bid / %llu ask, %lld shrs)\n",
            (unsigned long long)our_fills,
            (unsigned long long)our_bid_fills,
            (unsigned long long)our_ask_fills,
            (long long)our_fill_shrs);
    }
};

struct Simulator {
    DatabentoAdapter adapter;
    OrderBook        book;
    HawkesTriple     hawkes;
    KineticQueue     kinetic;
    InventoryManager inv;
    MarketMaker      mm;
    RiskGate         risk_gate;
    Logger           logger;
    SimStats         stats;

    int log_interval = 10'000;

    explicit Simulator(Logger lg = Logger{}) : logger(lg) {}

    void load_params(double mu_buy,  double a_buy,  double b_buy,
                     double mu_sell, double a_sell, double b_sell,
                     double mu_can,  double a_can,  double b_can,
                     double beta0, double beta1, double beta2, double beta3) {
        hawkes.buy    = HawkesProcess{mu_buy,  a_buy,  b_buy};
        hawkes.sell   = HawkesProcess{mu_sell, a_sell, b_sell};
        hawkes.cancel = HawkesProcess{mu_can,  a_can,  b_can};
        kinetic       = KineticQueue{beta0, beta1, beta2, beta3};
        inv.baseline_mo = hawkes.buy.mu  / (1.0 - hawkes.buy.branching_ratio())
                        + hawkes.sell.mu / (1.0 - hawkes.sell.branching_ratio());
    }

    void run(const std::string& dbn_path) {
        databento::DbnFileStore store{dbn_path};

        store.Replay([&](const databento::Record& rec) {
            const auto* msg = rec.GetIf<databento::MboMsg>();
            if (!msg) return databento::KeepGoing::Continue;

            OrderEvent ev = adapter.convert(*msg);
            ++stats.total_events;

            // Apply to book regardless of session (keeps state consistent).
            // Clear events also cancel our synthetic orders.
            if (ev.type == EventType::Clear) {
                book.apply(ev);
                mm.cancel_all();
                return databento::KeepGoing::Continue;
            }

            book.apply(ev);

            if (!in_regular_session(ev.timestamp_ns))
                return databento::KeepGoing::Continue;

            ++stats.session_events;

            // Per-day session_close update: A-S time-remaining and risk gate
            // both need the current trading day's close time.
            maybe_advance_day(ev.timestamp_ns);

            risk_gate.on_event(ev.timestamp_ns);

            const char action = static_cast<char>(msg->action);
            const char side   = static_cast<char>(msg->side);
            hawkes.update(ev.timestamp_ns, hawkes_event_type(action, side));

            if (action == 'F') {
                ++stats.trades;
                // side='A' → passive ask consumed (buy MO) → our ask might fill
                // side='B' → passive bid consumed (sell MO) → our bid might fill
                int8_t passive_side = (side == 'A') ? -1 : 1;
                FillResult fr = mm.check_our_fill(ev.price, passive_side, ev.size);
                if (fr.filled) {
                    inv.on_fill(fr.side, fr.fill_price, fr.fill_size);
                    int64_t mid = book.effective_mid();
                    int64_t pnl_delta = inv.total_pnl(mid > 0 ? mid : ev.price);
                    logger.fill(ev.timestamp_ns, fr.side, fr.fill_price, fr.fill_size, pnl_delta);
                    ++stats.our_fills;
                    if (fr.side ==  1) ++stats.our_bid_fills;
                    else               ++stats.our_ask_fills;
                    stats.our_fill_shrs += fr.fill_size;
                }
            } else if (action == 'C') {
                ++stats.cancels;
                int8_t passive_side = (side == 'A') ? -1 : 1;
                mm.on_cancel_at_level(ev.price, passive_side, ev.size);
            } else if (action == 'A') {
                ++stats.adds;
            }

            if (stats.session_events % (uint64_t)log_interval == 0)
                emit_snapshot(ev.timestamp_ns);

            return databento::KeepGoing::Continue;
        });

        stats.print();
    }

private:
    int64_t m_current_day_start_ns = 0;   // midnight UTC of current trading day

    // Compute the 21:00 UTC session close for the day containing t_ns.
    static int64_t session_close_for(int64_t t_ns) {
        constexpr int64_t NS_PER_SEC  = 1'000'000'000LL;
        constexpr int64_t NS_PER_DAY  = 86400LL * NS_PER_SEC;
        int64_t day_start = (t_ns / NS_PER_DAY) * NS_PER_DAY;
        return day_start + 21LL * 3600 * NS_PER_SEC;
    }

    void maybe_advance_day(int64_t t_ns) {
        constexpr int64_t NS_PER_DAY = 86400LL * 1'000'000'000LL;
        int64_t day_start = (t_ns / NS_PER_DAY) * NS_PER_DAY;
        if (day_start == m_current_day_start_ns) return;

        m_current_day_start_ns = day_start;
        int64_t close_ns = session_close_for(t_ns);

        inv.session_close_ns       = close_ns;
        risk_gate.session_close_ns = close_ns;

        int64_t mid = book.effective_mid();
        risk_gate.reset_for_session(t_ns, inv.total_pnl(mid > 0 ? mid : 0));
    }

    void emit_snapshot(int64_t t_ns) {
        auto tob = book.effective_tob();
        int64_t mid    = tob.valid ? (tob.bid + tob.ask) / 2 : book.mid_price();
        int64_t spread = tob.valid ? tob.ask - tob.bid      : book.spread();
        int64_t bqty   = tob.valid ? book.bids.at(tob.bid).total_quantity : book.bid_depth();
        int64_t aqty   = tob.valid ? book.asks.at(tob.ask).total_quantity : book.ask_depth();

        inv.update_vol(t_ns, mid);

        // update_quotes performs the single authoritative gate check internally.
        // Track the halted transition so we log it exactly once.
        bool was_halted = risk_gate.halted;
        mm.update_quotes(t_ns, book, hawkes, kinetic, inv, risk_gate);
        if (risk_gate.halted && !was_halted)
            logger.halt(t_ns, "daily_loss");

        logger.book(t_ns, mid, spread, bqty, aqty);
        logger.hawkes(t_ns,
            hawkes.buy.lambda_cur,
            hawkes.sell.lambda_cur,
            hawkes.cancel.lambda_cur,
            hawkes.flow_imbalance());

        if (mm.my_bid.active || mm.my_ask.active) {
            int64_t bid_px = mm.my_bid.active ? mm.my_bid.price : 0;
            int64_t ask_px = mm.my_ask.active ? mm.my_ask.price : 0;
            logger.quote(t_ns, bid_px, ask_px, mm.default_size);
        }

        logger.pnl(t_ns, inv.total_pnl(mid), 0, inv.inventory);
    }
};
