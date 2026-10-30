# Destination JSON files

Copy the example files to `destinations.json` and `locations.json`, then replace
their contents. Coordinates are kept in the neighbouring `locations.json` file and matched by `slug`, so coordinates do not
need to be repeated in the editorial content.

The application loads this folder automatically at startup. You can also import
another file manually:

```bash
python -m scripts.import_destinations app/data/destinations/destinations.json
```

If a destination has no matching location, the importer reports its slug and
does not import an incomplete record. `google_place_id` is optional, but adding
it makes generated Google Maps links more precise.

## Create files when you need them

The web app does not run this tool. Run it manually whenever you want to add or
update one destination:

```bash
python -m scripts.create_destination_files
```

The tool asks questions and updates `destinations.json` and `locations.json` by
slug. It keeps coordinates out of the content file and stores algorithm fields
such as categories, tags, visit duration, cost, terrain, difficulty,
family-friendliness, access notes, highlights, and seasonality.

You can also provide a prepared JSON object:

```bash
python -m scripts.create_destination_files --input my-place.json
```

The input object may contain `latitude`, `longitude`, `address`, and
`google_place_id`; the tool moves those location fields into `locations.json`.
