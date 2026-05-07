#pragma once
#include "book/Level.hpp"
#include <cmath>
#include <cstdint>

// Logistic fill model: P(fill | q, Q) = sigmoid(β₀ + β₁·(q/Q) + β₂·log(Q) + β₃·(q/Q)·log(Q))
//
// Conditions on both queue fraction and total depth. Q is a proxy for price-level activity:
// large queues trade more frequently, so even back-of-queue orders have non-trivial fill
// probability. β₁ and β₃ are expected negative (higher frac → lower P); β₂ positive
// (larger Q → higher P). Fitted by logistic regression in scripts/fit_gamma.py.
//
// Hard boundary guards are preserved: q=0 → P=1, q≥Q → P=0.
struct KineticQueue {
    double beta0 = -5.5;
    double beta1 = -4.0;
    double beta2 =  0.6;
    double beta3 =  0.15;

    KineticQueue() = default;
    explicit KineticQueue(double b0, double b1, double b2, double b3)
        : beta0(b0), beta1(b1), beta2(b2), beta3(b3) {}

    double fill_prob(int64_t q, int64_t Q) const noexcept {
        if (Q <= 0 || q < 0) return 0.0;
        if (q == 0)           return 1.0;
        if (q >= Q)           return 0.0;
        const double frac  = static_cast<double>(q) / static_cast<double>(Q);
        const double log_Q = std::log(static_cast<double>(Q));
        const double logit = beta0 + beta1 * frac + beta2 * log_Q + beta3 * frac * log_Q;
        return 1.0 / (1.0 + std::exp(-logit));
    }

    double fill_prob(const Level& lv) const noexcept {
        return fill_prob(lv.shares_ahead, lv.total_quantity);
    }

    // Marginal increase in fill probability per unit decrease in frac = q/Q.
    // dP/d(frac) = (β₁ + β₃·log(Q)) · P·(1−P); marginal priority is its negation
    // (moving forward improves P, so we negate the negative slope).
    double marginal_priority(int64_t q, int64_t Q) const noexcept {
        if (Q <= 0 || q <= 0 || q >= Q) return 0.0;
        const double log_Q = std::log(static_cast<double>(Q));
        const double p     = fill_prob(q, Q);
        return -(beta1 + beta3 * log_Q) * p * (1.0 - p);
    }
};
