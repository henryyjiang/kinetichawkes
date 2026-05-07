#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "strategy/InventoryManager.hpp"
#include <cstdint>
#include <cmath>

using Catch::Approx;

static constexpr int64_t MID      = 420'000'000'000LL;  // $420.00
static constexpr int64_t ONE_SEC  = 1'000'000'000LL;    // 1s in nanoseconds
static constexpr int64_t CLOSE_NS = 1'000'000LL * ONE_SEC;  // arbitrary far-future close

static InventoryManager make_inv() {
    InventoryManager m;
    m.gamma_as        = 0.1;
    m.base_spread     = 100'000'000;   // $0.10
    m.k_hawkes        = 1e8;
    m.baseline_mo     = 1.0;
    m.max_inventory   = 500;
    m.session_close_ns = CLOSE_NS;
    return m;
}

TEST_CASE("on_fill: inventory accumulates correctly", "[inventory]") {
    auto m = make_inv();
    REQUIRE(m.inventory == 0);
    REQUIRE(m.cash == 0);

    m.on_fill(+1, MID, 100);   // bought 100 @ $420
    REQUIRE(m.inventory == 100);
    REQUIRE(m.cash == -(MID * 100));

    m.on_fill(-1, MID, 50);    // sold 50 @ $420
    REQUIRE(m.inventory == 50);
    REQUIRE(m.cash == -(MID * 50));
}

TEST_CASE("on_fill: round-trip buy then sell leaves zero PnL at same price", "[inventory]") {
    auto m = make_inv();
    m.on_fill(+1, MID, 200);
    m.on_fill(-1, MID, 200);
    REQUIRE(m.inventory == 0);
    REQUIRE(m.cash == 0);
    REQUIRE(m.total_pnl(MID) == 0);
}

TEST_CASE("on_fill: sell at higher price captures spread", "[inventory]") {
    auto m = make_inv();
    int64_t buy_px  = MID - 50'000'000;   // $419.95
    int64_t sell_px = MID + 50'000'000;   // $420.05
    m.on_fill(+1, buy_px,  100);
    m.on_fill(-1, sell_px, 100);
    REQUIRE(m.inventory == 0);
    int64_t expected_pnl = (sell_px - buy_px) * 100;
    REQUIRE(m.total_pnl(MID) == expected_pnl);
}

TEST_CASE("total_pnl: marks inventory to mid", "[inventory]") {
    auto m = make_inv();
    m.on_fill(+1, MID, 100);                       // bought 100 @ $420 → cash = -420*100
    int64_t higher_mid = MID + 100'000'000;        // mid moves to $420.10
    int64_t expected   = -MID * 100 + (int64_t)((double)100 * higher_mid);
    REQUIRE(m.total_pnl(higher_mid) == expected);
}

TEST_CASE("reservation_price: flat when inventory=0", "[inventory]") {
    auto m = make_inv();
    m.sigma_sq = 1e12;   // large variance — should still give r = mid when inv = 0
    int64_t r = m.reservation_price(MID, 0);
    REQUIRE(r == MID);
}

TEST_CASE("reservation_price: long inventory skews down", "[inventory]") {
    auto m = make_inv();
    m.sigma_sq = 1e10;
    m.on_fill(+1, MID, 100);   // go long 100

    int64_t t_now   = 0;
    double  T_rem   = (CLOSE_NS - t_now) * 1e-9;
    double  skew    = 100.0 * 0.1 * 1e10 * T_rem;
    int64_t r_exp   = MID - static_cast<int64_t>(skew);
    REQUIRE(m.reservation_price(MID, t_now) == r_exp);
    REQUIRE(r_exp < MID);
}

TEST_CASE("reservation_price: short inventory skews up", "[inventory]") {
    auto m = make_inv();
    m.sigma_sq = 1e10;
    m.on_fill(-1, MID, 100);   // go short 100

    int64_t r = m.reservation_price(MID, 0);
    REQUIRE(r > MID);
}

TEST_CASE("reservation_price: skew shrinks to zero at session close", "[inventory]") {
    auto m = make_inv();
    m.sigma_sq = 1e10;
    m.on_fill(+1, MID, 100);

    // At exactly session_close_ns, T_rem = 0 → r = mid
    int64_t r = m.reservation_price(MID, CLOSE_NS);
    REQUIRE(r == MID);

    // Past close (T_rem clamped to 0)
    int64_t r_past = m.reservation_price(MID, CLOSE_NS + ONE_SEC);
    REQUIRE(r_past == MID);
}

TEST_CASE("compute_quotes: bid < reservation < ask", "[inventory]") {
    auto m = make_inv();
    int64_t t_now = 0;
    auto q = m.compute_quotes(MID, t_now, m.baseline_mo);
    REQUIRE(q.valid);
    int64_t r = m.reservation_price(MID, t_now);
    REQUIRE(q.bid_px < r);
    REQUIRE(q.ask_px > r);
    REQUIRE(q.ask_px - q.bid_px == m.base_spread);
}

TEST_CASE("compute_quotes: spread widens with excess MO intensity", "[inventory]") {
    auto m = make_inv();
    auto q_base   = m.compute_quotes(MID, 0, m.baseline_mo);
    auto q_spiky  = m.compute_quotes(MID, 0, m.baseline_mo + 2.0);

    REQUIRE(q_base.valid);
    REQUIRE(q_spiky.valid);
    int64_t spread_base  = q_base.ask_px  - q_base.bid_px;
    int64_t spread_spiky = q_spiky.ask_px - q_spiky.bid_px;
    REQUIRE(spread_spiky > spread_base);

    int64_t expected_extra = static_cast<int64_t>(m.k_hawkes * 2.0) * 2;
    REQUIRE(spread_spiky - spread_base == expected_extra);
}

TEST_CASE("compute_quotes: invalid when inventory at max", "[inventory]") {
    auto m = make_inv();
    m.on_fill(+1, MID, m.max_inventory);
    auto q = m.compute_quotes(MID, 0, m.baseline_mo);
    REQUIRE_FALSE(q.valid);
}

TEST_CASE("compute_quotes: invalid within 5 min of close", "[inventory]") {
    auto m = make_inv();
    int64_t near_close = CLOSE_NS - 299LL * ONE_SEC;   // 299s before close
    auto q = m.compute_quotes(MID, near_close, m.baseline_mo);
    REQUIRE_FALSE(q.valid);
}

TEST_CASE("update_vol: first call sets prev state, no sigma update", "[inventory]") {
    auto m = make_inv();
    m.update_vol(ONE_SEC, MID);
    REQUIRE(m.sigma_sq == Approx(0.0));
    REQUIRE(m.prev_mid_ns == ONE_SEC);
    REQUIRE(m.prev_mid_px == MID);
}

TEST_CASE("update_vol: EWMA updates on price move", "[inventory]") {
    auto m = make_inv();
    m.update_vol(ONE_SEC, MID);

    int64_t new_mid = MID + 100'000'000;   // $0.10 move
    m.update_vol(2 * ONE_SEC, new_mid);    // 1 second later

    double delta    = 100'000'000.0;
    double sample   = (delta * delta) / 1.0;   // dt = 1s
    double expected = m.ewma_alpha * sample;
    REQUIRE(m.sigma_sq == Approx(expected).epsilon(1e-9));
    REQUIRE(m.sigma_sq > 0.0);
}

TEST_CASE("update_vol: no update when dt too small", "[inventory]") {
    auto m = make_inv();
    m.update_vol(ONE_SEC, MID);
    m.update_vol(ONE_SEC + 100, MID + 1'000);   // dt = 100ns < 1µs threshold
    REQUIRE(m.sigma_sq == Approx(0.0));
}
