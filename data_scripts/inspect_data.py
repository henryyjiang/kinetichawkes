import databento as db
import datetime
from pathlib import Path

ROOT = Path(__file__).parent.parent
store = db.DBNStore.from_file(ROOT / "data/MSFT_20240303_20240314_mbo.dbn")

counts = {"buy": 0, "sell": 0, "cancel": 0, "add": 0, "other": 0}
first_ts = None
last_ts = None
sample_records = []

for i, rec in enumerate(store):
    ts = rec.ts_event
    if first_ts is None:
        first_ts = ts
    last_ts = ts

    action = chr(rec.action)
    side = chr(rec.side)

    if action in ("T", "F"):
        if side == "A":
            counts["buy"] += 1
        else:
            counts["sell"] += 1
    elif action == "C":
        counts["cancel"] += 1
    elif action == "A":
        counts["add"] += 1
    else:
        counts["other"] += 1

    if i < 5:
        price_dollars = rec.price / 1e9
        sample_records.append({
            "ts_ns": ts,
            "action": action,
            "side": side,
            "price": f"${price_dollars:.4f}",
            "size": rec.size,
            "order_id": rec.order_id,
        })

print("=== Event Counts ===")
for k, v in counts.items():
    print(f"  {k:8s}: {v:,}")

print(f"\n=== Date Range ===")
print(f"  First: {datetime.datetime.fromtimestamp(first_ts / 1e9, tz=datetime.timezone.utc)}")
print(f"  Last:  {datetime.datetime.fromtimestamp(last_ts / 1e9, tz=datetime.timezone.utc)}")

print(f"\n=== First 5 Records ===")
for r in sample_records:
    print(f"  {r}")