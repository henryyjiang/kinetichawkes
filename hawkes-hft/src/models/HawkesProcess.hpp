#pragma once
#include <cmath>
#include <cstdint>

struct HawkesProcess {
    double  mu    = 0.0;
    double  alpha = 0.0;
    double  beta  = 1.0;
    double  lambda_cur = 0.0;
    int64_t t_prev_ns  = 0;

    HawkesProcess() = default;
    HawkesProcess(double mu, double alpha, double beta)
        : mu(mu), alpha(alpha), beta(beta), lambda_cur(mu) {}

    void decay(int64_t t_ns) {
        double dt  = (t_ns - t_prev_ns) * 1e-9;
        lambda_cur = mu + std::exp(-beta * dt) * (lambda_cur - mu);
        t_prev_ns  = t_ns;
    }

    void fire(int64_t t_ns) {
        double dt  = (t_ns - t_prev_ns) * 1e-9;
        lambda_cur = mu + std::exp(-beta * dt) * (lambda_cur - mu) + alpha;
        t_prev_ns  = t_ns;
    }

    double branching_ratio() const { return alpha / beta; }
    bool   is_stationary()   const { return branching_ratio() < 1.0; }

    void reset(int64_t t_ns) {
        lambda_cur = mu;
        t_prev_ns  = t_ns;
    }
};
