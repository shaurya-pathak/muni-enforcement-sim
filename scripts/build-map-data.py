#!/usr/bin/env python3
"""Build the compact static map dataset used by the Muni simulation lab.

Usage: python3 scripts/build-map-data.py /path/to/muni_gtfs-current.zip /path/to/sf_arterials.geojson
"""
import csv
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime


def read_csv_from_zip(archive, name):
    with archive.open(name) as stream:
        return list(csv.DictReader(line.decode("utf-8-sig") for line in stream))


def key(value):
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def simplified(coords, limit=48):
    if len(coords) <= limit:
        return coords
    stride = max(1, len(coords) // limit)
    points = coords[::stride]
    if points[-1] != coords[-1]:
        points.append(coords[-1])
    return points


if len(sys.argv) != 3:
    raise SystemExit(__doc__)

gtfs_path, roads_path = sys.argv[1:]
with open("data/source/muni_ridership_route_month.csv", newline="", encoding="utf-8-sig") as stream:
    ridership_rows = list(csv.DictReader(stream))
latest_month = max(datetime.strptime(row["Month"], "%B %Y") for row in ridership_rows)
latest_label = latest_month.strftime("%B %Y")
latest_rows = [row for row in ridership_rows if row["Month"] == latest_label]
ridership = defaultdict(lambda: {"weekday": [], "weekend": [], "category": ""})
for row in latest_rows:
    record = ridership[row["Route"]]
    amount = row["Average Daily Boardings"].replace(",", "").strip()
    if amount:
        day = row["Service Day of the Week"]
        record["weekday" if day in {"Weekday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"} else "weekend"].append(float(amount))
    record["category"] = row["Service Category"]

with zipfile.ZipFile(gtfs_path) as z:
    routes_raw = read_csv_from_zip(z, "routes.txt")
    trips = read_csv_from_zip(z, "trips.txt")
    stop_times = read_csv_from_zip(z, "stop_times.txt")
    stops_raw = read_csv_from_zip(z, "stops.txt")
    shapes_raw = read_csv_from_zip(z, "shapes.txt")

routes_by_id = {row["route_id"]: row for row in routes_raw}
trip_by_id = {row["trip_id"]: row for row in trips}
stops_by_id = {row["stop_id"]: row for row in stops_raw}

# Join the ridership series to GTFS route names and IDs.
ridership_by_key = {key(name): (name, info) for name, info in ridership.items()}
routes = []
for route_id, row in routes_by_id.items():
    short = row.get("route_short_name", "").strip()
    long = row.get("route_long_name", "").strip().title()
    label = f"{short} {long}".strip()
    candidates = [key(label), key(f"{short} {row.get('route_long_name', '')}"), key(short)]
    match = next((ridership_by_key[candidate] for candidate in candidates if candidate in ridership_by_key), None)
    if not match:
        continue
    source_name, info = match
    weekday = sum(info["weekday"]) / len(info["weekday"]) if info["weekday"] else 0
    weekend = sum(info["weekend"]) / len(info["weekend"]) if info["weekend"] else 0
    routes.append({
        "id": route_id,
        "short": short,
        "name": source_name,
        "longName": long,
        "type": info["category"],
        "weekdayBoardings": round(weekday),
        "weekendBoardings": round(weekend),
        "color": "#" + row.get("route_color", "2563eb").strip().lstrip("#"),
        "textColor": "#" + row.get("route_text_color", "FFFFFF").strip().lstrip("#"),
        "geometry": [],
        "paths": [],
        "stopIds": [],
    })
routes.sort(key=lambda item: item["weekdayBoardings"], reverse=True)
route_ids = {route["id"] for route in routes}

shape_counts = Counter()
shape_dir_counts = Counter()
trip_shapes = {}
for trip in trips:
    if trip["route_id"] not in route_ids:
        continue
    shape = trip.get("shape_id")
    if not shape:
        continue
    key0 = (trip["route_id"], shape)
    shape_counts[key0] += 1
    shape_dir_counts[(trip["route_id"], trip.get("direction_id", "0"), shape)] += 1
    trip_shapes[trip["trip_id"]] = key0

chosen_shapes = defaultdict(set)
chosen_direction_shapes = defaultdict(dict)
for route in routes:
    directions = defaultdict(list)
    for (rid, direction, shape), count in shape_dir_counts.items():
        if rid == route["id"]:
            directions[direction].append((count, shape))
    for direction, options in directions.items():
        options.sort(reverse=True)
        chosen_shapes[route["id"]].add(options[0][1])
        chosen_direction_shapes[route["id"]][direction] = options[0][1]

shape_points = defaultdict(list)
for row in shapes_raw:
    if any(row["shape_id"] in shapes for shapes in chosen_shapes.values()):
        shape_points[row["shape_id"]].append((int(row["shape_pt_sequence"]), [float(row["shape_pt_lon"]), float(row["shape_pt_lat"])]))

route_by_id = {route["id"]: route for route in routes}
for route in routes:
    for shape in sorted(chosen_shapes[route["id"]]):
        coords = [point for _, point in sorted(shape_points[shape])]
        if len(coords) > 1:
            route["geometry"].append(simplified(coords))

route_trip_candidates = defaultdict(lambda: defaultdict(Counter))
for trip in trips:
    if trip["route_id"] in route_ids and trip.get("shape_id") in chosen_shapes[trip["route_id"]]:
        route_trip_candidates[trip["route_id"]][trip["shape_id"]][trip["trip_id"]] += 1

trip_stops = defaultdict(list)
for row in stop_times:
    trip_stops[row["trip_id"]].append((int(row["stop_sequence"]), row["stop_id"]))
for route in routes:
    for direction, shape in chosen_direction_shapes[route["id"]].items():
        candidates = route_trip_candidates[route["id"]][shape]
        if not candidates:
            continue
        trip_id = candidates.most_common(1)[0][0]
        ordered_stops = [stop_id for _, stop_id in sorted(trip_stops[trip_id]) if stop_id in stops_by_id]
        route["paths"].append({"direction": direction, "shape": shape, "stopIds": ordered_stops})

stop_route_membership = defaultdict(set)
for row in stop_times:
    trip = trip_by_id.get(row["trip_id"])
    if not trip or trip["route_id"] not in route_ids or trip.get("shape_id") not in chosen_shapes[trip["route_id"]]:
        continue
    stop = stops_by_id.get(row["stop_id"])
    if not stop or not stop.get("stop_lat") or not stop.get("stop_lon"):
        continue
    stop_id = row["stop_id"]
    stop_route_membership[stop_id].add(trip["route_id"])

for stop_id, route_set in stop_route_membership.items():
    for route_id in route_set:
        route_by_id[route_id]["stopIds"].append(stop_id)

stop_records = []
for stop_id, route_set in stop_route_membership.items():
    stop = stops_by_id[stop_id]
    stop_records.append({
        "id": stop_id,
        "name": stop.get("stop_name", "Muni stop"),
        "lat": float(stop["stop_lat"]),
        "lon": float(stop["stop_lon"]),
        "routes": sorted(route_set, key=lambda rid: route_by_id[rid]["weekdayBoardings"], reverse=True),
    })

for route in routes:
    route["stopIds"] = list(dict.fromkeys(stop_id for path in route["paths"] for stop_id in path["stopIds"]))

with open(roads_path, encoding="utf-8") as stream:
    roads_raw = json.load(stream)
roads = []
for feature in roads_raw.get("features", []):
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates") or []
    if geom.get("type") == "MultiLineString":
        lines = [simplified(line, 18) for line in coords if len(line) > 1]
    elif geom.get("type") == "LineString" and len(coords) > 1:
        lines = [simplified(coords, 18)]
    else:
        continue
    roads.append({"name": feature.get("properties", {}).get("streetname", ""), "lines": lines})

output = {
    "asOf": latest_label,
    "routeSource": "SFMTA average daily Muni boardings by route and month",
    "geometrySource": "SFMTA current GTFS routes and stops; San Francisco DataSF arterial street centerlines",
    "routes": routes,
    "stops": stop_records,
    "roads": roads,
}
with open("public/data/muni-map.json", "w", encoding="utf-8") as stream:
    json.dump(output, stream, separators=(",", ":"), ensure_ascii=False)
print(f"Wrote {len(routes)} routes, {len(stop_records)} stops, {len(roads)} street features ({latest_label})")
