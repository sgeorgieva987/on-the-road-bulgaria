"""Import or update destinations from a JSON file.

Usage: python -m scripts.import_destinations path/to/destinations.json [--locations path/to/locations.json]
"""
import argparse
from pathlib import Path

from app.db import SessionLocal
from app.services.destination_import import read_destination_file, upsert_destinations


def main() -> int:
    parser = argparse.ArgumentParser(description="Import destinations and optional sidecar locations.")
    parser.add_argument("path", type=Path, help="Destination JSON file")
    parser.add_argument("--locations", type=Path, help="Coordinates/Google Place IDs JSON file")
    args = parser.parse_args()
    path = args.path.resolve()
    if not path.is_file():
        print(f"File not found: {path}")
        return 2
    if args.locations and not args.locations.is_file():
        print(f"Locations file not found: {args.locations.resolve()}")
        return 2
    try:
        locations_path = args.locations.resolve() if args.locations else None
        records = read_destination_file(path, locations_path=locations_path)
        with SessionLocal() as db:
            created, updated = upsert_destinations(db, records)
    except (OSError, ValueError) as exc:
        print(f"Import failed: {exc}")
        return 1
    print(f"Imported {len(records)} records: {created} created, {updated} updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
