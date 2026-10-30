"""Create or update destination JSON files on demand.

This is intentionally a standalone tool. It is never imported by the web app
and never runs when the application starts.

Interactive usage:
    python -m scripts.create_destination_files

Non-interactive usage:
    python -m scripts.create_destination_files --input place.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


DEFAULT_DATA_DIR = Path(__file__).resolve().parents[1] / "app" / "data" / "destinations"


def slugify(value: str) -> str:
    transliteration = str.maketrans({
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh",
        "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
        "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts",
        "ч": "ch", "ш": "sh", "щ": "sht", "ъ": "a", "ь": "y", "ю": "yu", "я": "ya",
    })
    transliterated = value.casefold().translate(transliteration)
    slug = re.sub(r"[^a-z0-9]+", "-", transliterated).strip("-")
    if not slug:
        raise ValueError("The name must produce a non-empty Latin slug, or provide slug explicitly.")
    return slug


def ask(label: str, default: Any = None, *, required: bool = False) -> str:
    suffix = f" [{default}]" if default not in (None, "") else ""
    while True:
        value = input(f"{label}{suffix}: ").strip()
        if value:
            return value
        if default not in (None, ""):
            return str(default)
        if not required:
            return ""
        print("This value is required.")


def ask_float(label: str, default: float | None = None) -> float | None:
    while True:
        value = ask(label, default)
        if not value:
            return None
        try:
            return float(value)
        except ValueError:
            print("Enter a number or leave it blank.")


def ask_int(label: str, default: int | None = None) -> int | None:
    while True:
        value = ask(label, default)
        if not value:
            return None
        try:
            return int(value)
        except ValueError:
            print("Enter a whole number or leave it blank.")


def ask_list(label: str, default: list[str] | None = None) -> list[str]:
    initial = ", ".join(default or [])
    value = ask(f"{label} (comma separated)", initial)
    return [item.strip() for item in value.split(",") if item.strip()]


def ask_bool(label: str, default: bool = False) -> bool:
    value = ask(f"{label} (y/n)", "y" if default else "n").casefold()
    return value in {"y", "yes", "да", "д"}


def build_record() -> tuple[dict[str, Any], dict[str, Any]]:
    name = ask("Name", required=True)
    slug = ask("Slug", slugify(name), required=True)
    visit_minutes = ask_int("Estimated visit minutes", 60) or 60
    cost = ask_float("Estimated cost EUR")
    description = ask("Description", required=True)
    historical_context = ask("Historical context")
    categories = ask_list("Categories", ["история"])
    tags = ask_list("Tags")
    region = ask("Region")
    municipality = ask("Municipality")

    highlights = ask_list("Highlights")
    good_for = ask_list("Good for", categories[:2])
    consider_if = ask_list("Consider if")
    access = ask("Access notes")
    terrain = ask("Terrain")
    difficulty = ask("Difficulty", "Лесно")
    seasonal_months = ask_list("Best months (1-12)")
    family_friendly = ask_bool("Family friendly", False)

    # Content JSON deliberately does not contain coordinates or Google IDs.
    destination = {
        "slug": slug,
        "name": name,
        "region": region or None,
        "municipality": municipality or None,
        "description": description,
        "historical_context": historical_context or None,
        "categories": categories,
        "tags": tags,
        "estimated_visit_minutes": visit_minutes,
        "estimated_cost_eur": cost,
        "seasonal_months": [int(month) for month in seasonal_months] if seasonal_months else None,
        "information": {
            "summary": description,
            "highlights": highlights,
            "good_for": good_for,
            "consider_if": consider_if,
            "practical": {
                "visit_minutes": visit_minutes,
                "cost_eur": cost,
                "access": access or "Провери актуалния достъп преди пътуване.",
                "season": "Провери сезонните условия и ограничения.",
            },
            "experience": {
                "terrain": terrain or "Провери условията на място.",
                "family_friendly": family_friendly,
                "suggested_time": f"{visit_minutes} минути",
            },
            "decision": {
                "best_for": good_for[0] if good_for else "Откриване",
                "difficulty": difficulty,
            },
        },
    }

    location = {
        "slug": slug,
        "address": ask("Address or Google Maps search text"),
        "latitude": ask_float("Latitude (leave blank if not known)"),
        "longitude": ask_float("Longitude (leave blank if not known)"),
        "google_place_id": ask("Google Place ID (optional)") or None,
    }
    return destination, location


def load_array(path: Path, key: str) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get(key, payload) if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError(f"{path} must contain a JSON array of objects")
    return rows


def write_or_replace(path: Path, key: str, record: dict[str, Any]) -> None:
    rows = load_array(path, key)
    rows = [row for row in rows if row.get("slug") != record["slug"]]
    rows.append(record)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_input(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Input must be one JSON object")
    if not payload.get("name"):
        raise ValueError("Input must contain name")
    destination = dict(payload)
    location = {
        "slug": destination.get("slug") or slugify(str(destination["name"])),
        "address": destination.pop("address", None),
        "latitude": destination.pop("latitude", None),
        "longitude": destination.pop("longitude", None),
        "google_place_id": destination.pop("google_place_id", None),
    }
    destination["slug"] = location["slug"]
    return destination, location


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or update destination JSON files.")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--input", type=Path, help="Optional JSON object; omit to answer prompts interactively")
    args = parser.parse_args()

    try:
        destination, location = read_input(args.input) if args.input else build_record()
        destinations_path = args.data_dir / "destinations.json"
        locations_path = args.data_dir / "locations.json"
        write_or_replace(destinations_path, "destinations", destination)
        write_or_replace(locations_path, "locations", location)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Could not create destination files: {exc}")
        return 1

    print(f"Updated {destinations_path}")
    print(f"Updated {locations_path}")
    if location["latitude"] is None or location["longitude"] is None:
        print("Warning: coordinates are missing. Fill them in locations.json before importing into the app.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
