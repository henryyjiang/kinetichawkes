#!/usr/bin/env python3
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from numba import njit
from scipy.optimize import minimize

ROOT        = Path(__file__).parent.parent
CACHE_PATH  = ROOT / "data"    / "MSFT_20240303_20240314_mbo_cache.parquet"
CONFIG_PATH = ROOT / "configs" / "MSFT.json"

WEEK1_DAYS = [
    pd.Timestamp("2024-03-04", tz="UTC"),
    pd.Timestamp("2024-03-05", tz="UTC"),
    pd.Timestamp("2024-03-06", tz="UTC"),
    pd.Timestamp("2024-03-07", tz="UTC"),
    pd.Timestamp("2024-03-08", tz="UTC"),
]

INTER_DAY_GAP_SEC = 60.0   # cross-day R terms decay to zero at this gap (exp(-β·60) < 1e-130 for β>5)
CANCEL_STRIDE     = 15


@njit
def _nll_compiled(e_dt: np.ndarray, times: np.ndarray,
                  mu: float, alpha: float, beta: float, T: float) -> float:
    n = len(times)
    compensator = mu * T
    for i in range(n):
        compensator += (alpha / beta) * (1.0 - np.exp(-beta * (T - times[i])))

    R = 0.0
    log_lam_sum = 0.0
    for i in range(n):
        R = e_dt[i] * (1.0 + R)
        lam = mu + alpha * R
        if lam <= 0.0:
            return 1e15
        log_lam_sum += np.log(lam)

    return compensator - log_lam_sum


def _warmup_numba(times: np.ndarray) -> None:
    small = times[:min(500, len(times))].copy()
    dt    = np.diff(small, prepend=small[0])
    e_dt  = np.exp(-5.0 * dt)
    _nll_compiled(e_dt, small, 0.5, 0.3, 5.0, float(small[-1]))


def _make_objective(times: np.ndarray, T: float):
    dt = np.diff(times, prepend=times[0])

    def neg_ll(params):
        mu, alpha, beta = params
        if mu <= 0.0 or alpha <= 0.0 or beta <= 0.0 or alpha / beta >= 1.0:
            return 1e15
        e_dt = np.exp(-beta * dt)
        return _nll_compiled(e_dt, times, mu, alpha, beta, T)

    return neg_ll


def calibrate(name: str, times: np.ndarray, T: float) -> dict:
    n         = len(times)
    mean_rate = n / T

    print(f"\n--- {name} ---")
    print(f"  events : {n:,}")
    print(f"  T      : {T:,.0f} s  ({T/3600:.2f} h)")
    print(f"  rate   : {mean_rate:.4f} ev/s")

    obj = _make_objective(times, T)

    starts = [
        [mean_rate * fm, mean_rate * fa, b]
        for fm in [0.6, 0.3]
        for fa in [0.2, 0.5]
        for b  in [3.0, 10.0, 30.0]
    ]

    best_nll    = np.inf
    best_params = None

    t0 = time.time()
    for x0 in starts:
        try:
            res = minimize(
                obj,
                x0=np.array(x0, dtype=np.float64),
                method="L-BFGS-B",
                bounds=[(1e-8, None), (1e-8, None), (1e-8, None)],
                options={"maxiter": 3000, "ftol": 1e-14, "gtol": 1e-10},
            )
            if res.fun < best_nll:
                best_nll    = res.fun
                best_params = res.x
        except Exception:
            pass

    if best_params is None:
        print("  ERROR: all restarts failed")
        best_params = np.array([mean_rate * 0.5, mean_rate * 0.3, 5.0])

    mu, alpha, beta = best_params
    br              = alpha / beta
    e_lambda        = mu / (1.0 - br) if br < 1.0 else float("inf")

    print(f"  mu           = {mu:.6f}")
    print(f"  alpha        = {alpha:.6f}")
    print(f"  beta         = {beta:.6f}")
    print(f"  alpha/beta   = {br:.4f}  {'[OK]' if br < 1.0 else '[FAIL — non-stationary!]'}")
    print(f"  E[lambda]    = {e_lambda:.4f} ev/s")
    print(f"  elapsed      = {time.time()-t0:.1f}s")

    return {
        "mu":              float(mu),
        "alpha":           float(alpha),
        "beta":            float(beta),
        "branching_ratio": float(br),
        "stationary":      bool(br < 1.0),
        "E_lambda":        float(e_lambda),
        "n_events":        int(n),
        "T_seconds":       float(T),
        "mean_rate_ev_s":  float(mean_rate),
    }


def build_session_times(df: pd.DataFrame, days: list) -> tuple:
    buy_all, sell_all, cancel_all = [], [], []
    t_cursor = 0.0

    for day in days:
        mask   = (df.index >= day) & (df.index < day + pd.Timedelta(days=1))
        df_day = df[mask]

        if len(df_day) == 0:
            print(f"  WARNING: no records for {day.date()}")
            continue

        ts_sec     = df_day.index.astype("int64").values * 1e-9
        session_t0 = ts_sec[0]
        session_T  = ts_sec[-1] - session_t0

        ts_rel = ts_sec - session_t0 + t_cursor

        act  = df_day["action"].values
        side = df_day["side"].values

        buy_mask  = (act == "F") & (side == "A")
        sell_mask = (act == "F") & (side == "B")
        can_mask  = (act == "C")

        buy_all.append(ts_rel[buy_mask])
        sell_all.append(ts_rel[sell_mask])
        cancel_all.append(ts_rel[can_mask])

        b = buy_mask.sum(); s = sell_mask.sum(); c = can_mask.sum()
        print(f"  {day.date()}  {b:>6,} buys  {s:>6,} sells  {c:>8,} cancels")

        t_cursor += session_T + INTER_DAY_GAP_SEC

    T_total      = t_cursor - INTER_DAY_GAP_SEC
    buy_times    = np.concatenate(buy_all)
    sell_times   = np.concatenate(sell_all)
    cancel_times = np.concatenate(cancel_all)

    return buy_times, sell_times, cancel_times, T_total


def main() -> None:
    print("Hawkes MLE Calibration — MSFT Week 1 (2024-03-04 to 2024-03-08)")

    print(f"\nLoading {CACHE_PATH.name}...")
    t0 = time.time()
    df = pd.read_parquet(str(CACHE_PATH))
    df.index = pd.to_datetime(df["ts_ns"], utc=True)
    df = df.drop(columns=["ts_ns"])
    print(f"  {len(df):,} records in {time.time()-t0:.1f}s")

    print("\nBuilding session timelines (Week 1):")
    buy_times, sell_times, cancel_times, T = build_session_times(df, WEEK1_DAYS)

    print(f"\nTotal T        = {T:,.0f} s  ({T/3600:.2f} h)")
    print(f"buy events     = {len(buy_times):,}")
    print(f"sell events    = {len(sell_times):,}")
    print(f"cancel events  = {len(cancel_times):,}")

    cancel_sub = cancel_times[::CANCEL_STRIDE]
    print(f"cancel (1/{CANCEL_STRIDE})  = {len(cancel_sub):,}")

    print("\nWarming up numba JIT...")
    _warmup_numba(buy_times)
    print("  done")

    print("\nRunning MLE  (L-BFGS-B, 12 restarts per process)")
    t_cal = time.time()

    res_buy    = calibrate("buy_mo",  buy_times,   T)
    res_sell   = calibrate("sell_mo", sell_times,  T)
    res_cancel = calibrate("cancel",  cancel_sub,  T)

    print(f"\nCalibration completed in {time.time()-t_cal:.1f}s")

    CONFIG_PATH.parent.mkdir(exist_ok=True)
    config = {
        "instrument":         "MSFT",
        "dataset":            "XNAS.ITCH",
        "calibration_period": "Week 1: 2024-03-04 to 2024-03-08",
        "cancel_subsample":   f"1/{CANCEL_STRIDE}",
        "buy":                res_buy,
        "sell":               res_sell,
        "cancel":             res_cancel,
    }
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    print(f"\nSaved → {CONFIG_PATH}")

    print("\nSummary")
    all_ok = True
    for name, res in [("buy", res_buy), ("sell", res_sell), ("cancel", res_cancel)]:
        br     = res["branching_ratio"]
        ok     = res["stationary"]
        all_ok = all_ok and ok
        flag   = "OK  " if ok else "FAIL"
        print(
            f"  [{flag}]  {name:8s}  mu={res['mu']:.5f}  alpha={res['alpha']:.5f}"
            f"  beta={res['beta']:.4f}  alpha/beta={br:.4f}"
            f"  E[lam]={res['E_lambda']:.4f} ev/s"
        )

    if all_ok:
        print("\n  All three processes stationary.")
    else:
        print("\n  WARNING: non-stationary process detected.")
        sys.exit(1)


if __name__ == "__main__":
    main()
