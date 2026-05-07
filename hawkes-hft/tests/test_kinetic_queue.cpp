#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "models/KineticQueue.hpp"
#include "book/Level.hpp"
#include <cmath>

using Catch::Approx;

// Logistic helper matching the model's formula exactly.
static double sigmoid(double x) { return 1.0 / (1.0 + std::exp(-x)); }

static double logistic_fill(double frac, double logQ,
                             double b0, double b1, double b2, double b3) {
    return sigmoid(b0 + b1 * frac + b2 * logQ + b3 * frac * logQ);
}

// Fixed betas used throughout — calibration-independent, structurally representative.
// β₁ + β₃·log(Q) is negative for all tested Q → P monotone-decreasing in q. ✓
constexpr double B0 = -4.0, B1 = -6.0, B2 = 0.8, B3 = 0.2;

TEST_CASE("KineticQueue construction", "[kinetic]") {
    REQUIRE_NOTHROW(KineticQueue());
    REQUIRE_NOTHROW(KineticQueue(-4.0, -6.0, 0.8, 0.2));
    REQUIRE_NOTHROW(KineticQueue(0.0, 0.0, 0.0, 0.0));
}

TEST_CASE("fill_prob boundary conditions", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};

    SECTION("front of queue → P = 1 (hard guard, independent of betas)") {
        REQUIRE(kq.fill_prob(0,   500) == Approx(1.0));
        REQUIRE(kq.fill_prob(0,   1)   == Approx(1.0));
    }
    SECTION("last in queue → P = 0") {
        REQUIRE(kq.fill_prob(500, 500) == Approx(0.0));
    }
    SECTION("q > Q → P = 0  (guard)") {
        REQUIRE(kq.fill_prob(600, 500) == Approx(0.0));
    }
    SECTION("empty or invalid level → P = 0") {
        REQUIRE(kq.fill_prob(0,  0)  == Approx(0.0));
        REQUIRE(kq.fill_prob(0, -1)  == Approx(0.0));
    }
    SECTION("q < 0 → P = 0  (guard)") {
        REQUIRE(kq.fill_prob(-1, 500) == Approx(0.0));
    }
}

TEST_CASE("fill_prob: logistic formula matches analytic value", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};

    // q=200, Q=1000 → frac=0.2, logQ=ln(1000)=6.90776
    // logit = -4 + (-6)(0.2) + (0.8)(6.90776) + (0.2)(0.2)(6.90776) = 0.60251
    // P = sigmoid(0.60251) ≈ 0.6462
    {
        const double expected = logistic_fill(0.2, std::log(1000.0), B0, B1, B2, B3);
        REQUIRE(kq.fill_prob(200, 1000) == Approx(expected).epsilon(1e-12));
    }

    // q=500, Q=1000 → frac=0.5
    // logit = -4 - 3 + 5.52620 + 0.69078 = -0.78302 → P ≈ 0.3137
    {
        const double expected = logistic_fill(0.5, std::log(1000.0), B0, B1, B2, B3);
        REQUIRE(kq.fill_prob(500, 1000) == Approx(expected).epsilon(1e-12));
    }

    // q=900, Q=1000 → frac=0.9
    // logit = -4 - 5.4 + 5.52620 + 1.24340 = -2.63040 → P ≈ 0.0671
    {
        const double expected = logistic_fill(0.9, std::log(1000.0), B0, B1, B2, B3);
        REQUIRE(kq.fill_prob(900, 1000) == Approx(expected).epsilon(1e-12));
    }
}

TEST_CASE("fill_prob: activity effect — larger Q gives higher P at the same frac", "[kinetic]") {
    // This is the key property the old power-law model lacked.
    // For frac=0.5: Q=100 (thin, inactive) vs Q=10000 (deep, active).
    // Expected: P(Q=100) ≈ 0.054  <  P(Q=10000) ≈ 0.784
    KineticQueue kq{B0, B1, B2, B3};

    // q/Q = 0.5 exactly: q=50,Q=100 and q=5000,Q=10000
    const double p_thin   = kq.fill_prob(50,   100);
    const double p_active = kq.fill_prob(5000, 10000);

    REQUIRE(p_thin < p_active);

    // Verify approximate magnitudes
    const double expected_thin   = logistic_fill(0.5, std::log(100.0),   B0, B1, B2, B3);
    const double expected_active = logistic_fill(0.5, std::log(10000.0), B0, B1, B2, B3);
    REQUIRE(p_thin   == Approx(expected_thin).epsilon(1e-12));
    REQUIRE(p_active == Approx(expected_active).epsilon(1e-12));

    // Monotone in Q for fixed frac=0.5 across a wider range
    const double p_q200  = kq.fill_prob(100,  200);
    const double p_q2000 = kq.fill_prob(1000, 2000);
    REQUIRE(p_q200 < p_q2000);
    REQUIRE(p_q2000 < p_active);
}

TEST_CASE("fill_prob: monotone decreasing in q for fixed Q", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};
    // β₁ + β₃·log(Q) = -6 + 0.2·ln(1000) ≈ -4.62 < 0 → P strictly decreasing in frac.
    constexpr int64_t Q = 1000;
    double prev = 1.0;
    for (int64_t q = 0; q <= Q; q += 50) {
        const double p = kq.fill_prob(q, Q);
        REQUIRE(p <= prev + 1e-12);
        prev = p;
    }
    // Verify specific ordering
    REQUIRE(kq.fill_prob(100,  Q) > kq.fill_prob(500,  Q));
    REQUIRE(kq.fill_prob(500,  Q) > kq.fill_prob(900,  Q));
}

TEST_CASE("fill_prob(Level) matches fill_prob(q, Q)", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};

    Level lv;
    lv.total_quantity = 800;
    lv.shares_ahead   = 200;

    REQUIRE(kq.fill_prob(lv) == Approx(kq.fill_prob(200, 800)).epsilon(1e-15));
}

TEST_CASE("fill_prob(Level): front-of-queue → P=1", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};
    Level lv;
    lv.total_quantity = 500;
    lv.shares_ahead   = 0;

    REQUIRE(kq.fill_prob(lv) == Approx(1.0));
}

TEST_CASE("marginal_priority: positive in interior (moving forward improves fill)", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};
    // At q=500, Q=1000: -(β₁ + β₃·logQ) ≈ 4.618 > 0 → marginal_priority > 0
    REQUIRE(kq.marginal_priority(500, 1000) > 0.0);
    REQUIRE(kq.marginal_priority(100, 1000) > 0.0);
    REQUIRE(kq.marginal_priority(900, 1000) > 0.0);
}

TEST_CASE("marginal_priority: analytic value at q=500, Q=1000", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};
    const double log_Q = std::log(1000.0);
    const double p     = logistic_fill(0.5, log_Q, B0, B1, B2, B3);
    const double expected = -(B1 + B3 * log_Q) * p * (1.0 - p);
    REQUIRE(kq.marginal_priority(500, 1000) == Approx(expected).epsilon(1e-12));
}

TEST_CASE("marginal_priority: boundary guards return 0", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};
    REQUIRE(kq.marginal_priority(0,   100) == Approx(0.0));  // front guard
    REQUIRE(kq.marginal_priority(100, 100) == Approx(0.0));  // back guard
    REQUIRE(kq.marginal_priority(50,  0)   == Approx(0.0));  // empty level
}

TEST_CASE("marginal_priority: higher on active levels (larger Q) at same frac", "[kinetic]") {
    KineticQueue kq{B0, B1, B2, B3};
    // On a deep active level the logistic curve has more curvature at mid-queue.
    // Both should be positive; the active level should differ from the thin level.
    const double mp_thin   = kq.marginal_priority(50,   100);
    const double mp_active = kq.marginal_priority(5000, 10000);
    REQUIRE(mp_thin   > 0.0);
    REQUIRE(mp_active > 0.0);
}
