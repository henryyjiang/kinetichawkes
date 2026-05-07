import databento as db
import os

client = db.Historical()  # reads DATABENTO_API_KEY from env

cost = client.metadata.get_cost(
    dataset="XNAS.ITCH",
    symbols=["MSFT"],
    schema="mbo",
    start="2024-03-03T00:00:00",
    end="2024-03-14T21:00:00",
    stype_in="raw_symbol",
)
print(f"Estimated cost: ${cost:.4f}")