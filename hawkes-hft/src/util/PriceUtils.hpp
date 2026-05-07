#pragma once
#include <cstdint>
#include <cmath>

// Databento prices are nanodollars: $1.00 = 1_000_000_000
static constexpr int64_t TICK_SIZE        = 10'000'000;    // $0.01 — MSFT penny tick
static constexpr int64_t NANOS_PER_DOLLAR = 1'000'000'000;

inline double to_dollars(int64_t nano) {
    return static_cast<double>(nano) / NANOS_PER_DOLLAR;
}

inline int64_t to_nanos(double dollars) {
    return static_cast<int64_t>(dollars * NANOS_PER_DOLLAR);
}

inline int64_t round_to_tick(int64_t price) {
    return (price / TICK_SIZE) * TICK_SIZE;
}

// 09:30–16:00 ET = 13:30–21:00 UTC
inline bool in_regular_session(int64_t ts_ns) {
    constexpr int64_t NANOS_PER_SEC = 1'000'000'000LL;
    constexpr int64_t SECS_PER_DAY  = 86'400LL;
    int64_t sod_ns = ts_ns % (SECS_PER_DAY * NANOS_PER_SEC);
    constexpr int64_t SESSION_OPEN  = (13 * 3600 + 30 * 60) * NANOS_PER_SEC;
    constexpr int64_t SESSION_CLOSE = (21 * 3600)            * NANOS_PER_SEC;
    return sod_ns >= SESSION_OPEN && sod_ns < SESSION_CLOSE;
}
