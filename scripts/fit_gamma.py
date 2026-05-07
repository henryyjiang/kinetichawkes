#!/usr/bin/env python3
import json
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

ROOT        = Path(__file__).parent.parent
CACHE_PATH  = ROOT / "data"    / "MSFT_20240303_20240314_mbo_cache.parquet"
CONFIG_PATH = ROOT / "configs" / "MSFT.json"
PLOT_PATH   = ROOT / "gamma_fit.png"

FIT_DAY     = pd.Timestamp("2024-03-04", tz="UTC")
FIT_DAY_END = pd.Timestamp("2024-03-05", tz="UTC")
N_FRAC_BUCKETS = 10
N_Q_BUCKETS    = 5


@dataclass
class TrackedLevel:
    total_quantity: int = 0
    orders: OrderedDict = field(default_factory=OrderedDict)

    def shares_ahead_of(self, order_id: int) -> int:
        ahead = 0
        for oid, sz in self.orders.items():
            if oid == order_id:
                break
            ahead += sz
        return ahead

    def add(self, order_id: int, size: int) -> None:
        self.orders[order_id] = size
        self.total_quantity  += size

    def cancel(self, order_id: int, cancelled: int) -> None:
        if order_id not in self.orders:
            return
        self.orders[order_id] -= cancelled
        self.total_quantity   -= cancelled
        if self.orders[order_id] <= 0:
            del self.orders[order_id]

    def fill(self, order_id: int, executed: int) -> None:
        self.total_quantity -= executed
        if order_id in self.orders:
            self.orders[order_id] -= executed
            if self.orders[order_id] <= 0:
                del self.orders[order_id]

    def empty(self) -> bool:
        return self.total_quantity <= 0


@dataclass
class PlacementRecord:
    frac: float
    Q:    int   # total queue depth at placement — activity proxy


def run_book_replay(df: pd.DataFrame) -> tuple[list, list, list, list, int]:
    levels: dict[tuple, TrackedLevel] = {}
    placement: dict[int, PlacementRecord] = {}
    order_meta: dict[int, tuple] = {}

    filled_fracs    = []
    filled_Qs       = []
    cancelled_fracs = []
    cancelled_Qs    = []
    n_front         = 0

    act_col   = df["action"].values
    side_col  = df["side"].values
    price_col = df["price"].values
    size_col  = df["size"].values
    oid_col   = df["order_id"].values if "order_id" in df.columns else np.zeros(len(df), dtype=np.int64)

    for i in range(len(df)):
        action = act_col[i]
        side   = side_col[i]
        price  = price_col[i]
        size   = int(size_col[i])
        oid    = int(oid_col[i])
        key    = (price, side)

        if action == "A":
            if key not in levels:
                levels[key] = TrackedLevel()
            lv = levels[key]
            Q  = lv.total_quantity
            lv.add(oid, size)
            order_meta[oid] = key

            if Q == 0:
                placement[oid] = PlacementRecord(frac=0.0, Q=size)
                n_front += 1
            else:
                placement[oid] = PlacementRecord(frac=Q / (Q + size), Q=Q + size)

        elif action == "C":
            if oid in order_meta:
                key = order_meta[oid]
                if key in levels:
                    lv = levels[key]
                    rec = placement.pop(oid, None)
                    if rec is not None:
                        cancelled_fracs.append(rec.frac)
                        cancelled_Qs.append(rec.Q)
                    lv.cancel(oid, size)
                    if lv.empty():
                        del levels[key]
                    del order_meta[oid]

        elif action == "F":
            if oid in order_meta:
                key = order_meta[oid]
                if key in levels:
                    lv = levels[key]
                    rec = placement.pop(oid, None)
                    if rec is not None:
                        filled_fracs.append(rec.frac)
                        filled_Qs.append(rec.Q)
                    lv.fill(oid, size)
                    if lv.empty():
                        del levels[key]
                    del order_meta[oid]

    return filled_fracs, filled_Qs, cancelled_fracs, cancelled_Qs, n_front


def fit_logistic(filled_fracs: list, filled_Qs: list,
                 cancelled_fracs: list, cancelled_Qs: list) -> tuple[float, float, float, float]:
    """
    Fit P(fill | frac, Q) = sigmoid(β₀ + β₁·frac + β₂·log(Q) + β₃·frac·log(Q))
    via logistic regression on the combined fill/cancel sample.
    Excludes front-of-queue (frac=0) observations — those are hard-guarded.
    """
    fracs  = np.array(filled_fracs + cancelled_fracs, dtype=np.float64)
    Qs     = np.array(filled_Qs    + cancelled_Qs,    dtype=np.float64)
    labels = np.array([1] * len(filled_fracs) + [0] * len(cancelled_fracs), dtype=np.int32)

    # Exclude front-of-queue (frac==0) and any degenerate Q
    mask = (fracs > 1e-6) & (Qs > 0)
    fracs, Qs, labels = fracs[mask], Qs[mask], labels[mask]

    log_Q = np.log(Qs)
    X = np.column_stack([fracs, log_Q, fracs * log_Q])

    clf = LogisticRegression(fit_intercept=True, max_iter=1000, solver="lbfgs")
    clf.fit(X, labels)

    beta0 = float(clf.intercept_[0])
    beta1, beta2, beta3 = clf.coef_[0].tolist()
    return beta0, beta1, beta2, beta3


def empirical_fill_rate_2d(filled_fracs, filled_Qs, cancelled_fracs, cancelled_Qs,
                            n_frac=N_FRAC_BUCKETS, n_q=N_Q_BUCKETS):
    """Returns mean empirical fill rate in (frac, log_Q) buckets."""
    fracs  = np.array(filled_fracs + cancelled_fracs)
    Qs     = np.array(filled_Qs    + cancelled_Qs)
    labels = np.array([1] * len(filled_fracs) + [0] * len(cancelled_fracs))

    mask = (fracs > 1e-6) & (Qs > 0)
    fracs, Qs, labels = fracs[mask], Qs[mask], labels[mask]
    log_Q = np.log(Qs)

    frac_edges = np.linspace(fracs.min(), fracs.max(), n_frac + 1)
    q_edges    = np.linspace(log_Q.min(), log_Q.max(), n_q + 1)

    rate_grid  = np.full((n_q, n_frac), np.nan)
    for i in range(n_q):
        for j in range(n_frac):
            sel = ((fracs  >= frac_edges[j]) & (fracs  < frac_edges[j+1]) &
                   (log_Q  >= q_edges[i])    & (log_Q  < q_edges[i+1]))
            if sel.sum() > 10:
                rate_grid[i, j] = labels[sel].mean()

    return frac_edges, q_edges, rate_grid


def make_plot(filled_fracs, filled_Qs, cancelled_fracs, cancelled_Qs,
              beta0, beta1, beta2, beta3) -> None:
    frac_edges, q_edges, emp_grid = empirical_fill_rate_2d(
        filled_fracs, filled_Qs, cancelled_fracs, cancelled_Qs)

    frac_mids = 0.5 * (frac_edges[:-1] + frac_edges[1:])
    q_mids    = 0.5 * (q_edges[:-1]    + q_edges[1:])

    # Model predictions on same grid
    frac_g, q_g = np.meshgrid(frac_mids, q_mids)
    logit = beta0 + beta1 * frac_g + beta2 * q_g + beta3 * frac_g * q_g
    model_grid = 1.0 / (1.0 + np.exp(-logit))

    fig, axes = plt.subplots(1, 3, figsize=(18, 5))

    # 1. Empirical fill rate heatmap
    ax = axes[0]
    im = ax.imshow(emp_grid, origin="lower", aspect="auto",
                   extent=[frac_edges[0], frac_edges[-1], q_edges[0], q_edges[-1]],
                   vmin=0, vmax=0.3, cmap="viridis")
    plt.colorbar(im, ax=ax)
    ax.set_xlabel("Queue fraction (q/Q)")
    ax.set_ylabel("log(Q) at placement")
    ax.set_title("Empirical fill rate\n(2D: frac × log Q)")

    # 2. Model fill rate heatmap
    ax = axes[1]
    im2 = axes[1].imshow(model_grid, origin="lower", aspect="auto",
                          extent=[frac_edges[0], frac_edges[-1], q_edges[0], q_edges[-1]],
                          vmin=0, vmax=0.3, cmap="viridis")
    plt.colorbar(im2, ax=ax)
    ax.set_xlabel("Queue fraction (q/Q)")
    ax.set_ylabel("log(Q) at placement")
    ax.set_title(f"Model P = σ(β₀ + β₁·f + β₂·logQ + β₃·f·logQ)\n"
                 f"β=({beta0:.2f}, {beta1:.2f}, {beta2:.2f}, {beta3:.2f})")

    # 3. Model curves by Q quintile
    ax = axes[2]
    q_grid = np.linspace(0.01, 0.99, 200)
    for q_val, color, label in zip(
            np.percentile(np.log(np.array(filled_Qs + cancelled_Qs)), [10, 30, 50, 70, 90]),
            ["#2166ac", "#4dac26", "#d7191c", "#fdae61", "#abd9e9"],
            ["Q p10", "Q p30", "Q p50", "Q p70", "Q p90"]):
        logit = beta0 + beta1 * q_grid + beta2 * q_val + beta3 * q_grid * q_val
        p = 1.0 / (1.0 + np.exp(-logit))
        ax.plot(q_grid, p, color=color, lw=1.8, label=f"{label} (logQ={q_val:.1f})")
    ax.set_xlabel("Queue fraction (q/Q)")
    ax.set_ylabel("P(fill)")
    ax.set_title("Model fill curves by Q percentile")
    ax.legend(fontsize=8)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.grid(alpha=0.3)

    plt.suptitle("MSFT KineticQueue — Conditional Fill Model  (2024-03-04)", y=1.01)
    plt.tight_layout()
    plt.savefig(str(PLOT_PATH), bbox_inches="tight")
    print(f"Plot saved → {PLOT_PATH}")


def main() -> None:
    print("KineticQueue Conditional Fill Model Calibration  (2024-03-04)")

    print(f"\nLoading {CACHE_PATH.name}...")
    t0 = time.time()
    df = pd.read_parquet(str(CACHE_PATH))

    if "order_id" not in df.columns:
        print("  WARNING: order_id not in parquet cache — rebuild cache with order_id included")
        return

    lo_ns  = FIT_DAY.value
    hi_ns  = FIT_DAY_END.value
    df_day = df[(df["ts_ns"] >= lo_ns) & (df["ts_ns"] < hi_ns)].reset_index(drop=True)

    print(f"  {len(df_day):,} records loaded in {time.time()-t0:.1f}s")
    print(f"  Day: {FIT_DAY.date()}  |  actions: "
          + "  ".join(f"{a}={v:,}" for a, v in df_day["action"].value_counts().items()))

    print("\nReplaying L3 book to track queue positions and depths...")
    t1 = time.time()
    filled_fracs, filled_Qs, cancelled_fracs, cancelled_Qs, n_front = run_book_replay(df_day)
    print(f"  Replay: {time.time()-t1:.1f}s")
    print(f"  Filled orders tracked:    {len(filled_fracs):,}")
    print(f"  Cancelled orders tracked: {len(cancelled_fracs):,}")
    print(f"  Front-of-queue (frac=0):  {n_front:,}")

    if len(filled_fracs) < 100:
        print("\n  ERROR: too few fill observations — check data or date range")
        return

    print("\nFitting logistic model P(fill|frac,Q) = σ(β₀ + β₁·frac + β₂·logQ + β₃·frac·logQ)...")
    t2 = time.time()
    beta0, beta1, beta2, beta3 = fit_logistic(
        filled_fracs, filled_Qs, cancelled_fracs, cancelled_Qs)
    print(f"  β₀={beta0:.4f}  β₁={beta1:.4f}  β₂={beta2:.4f}  β₃={beta3:.4f}  "
          f"(elapsed {time.time()-t2:.2f}s)")

    print(f"\n  Interpretation:")
    print(f"  β₁={beta1:.3f}: fill prob {'decreases' if beta1 < 0 else 'increases'} with frac (conditional on Q)")
    print(f"  β₂={beta2:.3f}: fill prob {'increases' if beta2 > 0 else 'decreases'} with queue depth (activity proxy)")
    print(f"  β₃={beta3:.3f}: interaction — frac effect {'weakens' if beta3 > 0 else 'strengthens'} on active levels")

    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            config = json.load(f)
    else:
        config = {}

    config["kinetic"] = {
        "beta0": beta0,
        "beta1": beta1,
        "beta2": beta2,
        "beta3": beta3,
        "model":          "logistic: P = sigmoid(beta0 + beta1*frac + beta2*log(Q) + beta3*frac*log(Q))",
        "fit_day":        str(FIT_DAY.date()),
        "n_filled":       int(len(filled_fracs)),
        "n_cancelled":    int(len(cancelled_fracs)),
        "n_front_of_queue": int(n_front),
    }
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    print(f"\nUpdated → {CONFIG_PATH}")

    make_plot(filled_fracs, filled_Qs, cancelled_fracs, cancelled_Qs,
              beta0, beta1, beta2, beta3)


if __name__ == "__main__":
    main()
