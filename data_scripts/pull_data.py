import databento as db
from pathlib import Path

ROOT = Path(__file__).parent.parent
(ROOT / "data").mkdir(exist_ok=True)
client = db.Historical()

print("Pulling MSFT MBO data (Mar 3–14 2024)...")
data = client.timeseries.get_range(
    dataset="XNAS.ITCH",
    symbols=["MSFT"],
    schema="mbo",
    start="2024-03-03T00:00:00",
    end="2024-03-14T21:00:00",
    stype_in="raw_symbol",
)

out_path = ROOT / "data/MSFT_20240303_20240314_mbo.dbn"
data.to_file(out_path)
print(f"Saved to {out_path}")