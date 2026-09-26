#!/usr/bin/env python3
"""Extract one representative weekday of scheduled Muni trips from SFMTA GTFS."""
import csv
import json
import sys
import zipfile
from collections import defaultdict
from datetime import date, timedelta


def rows(archive, name):
    with archive.open(name) as stream:
        return list(csv.DictReader(line.decode("utf-8-sig") for line in stream))


def minutes(value):
    hour, minute, _ = value.split(":")
    return int(hour) * 60 + int(minute)


if len(sys.argv) != 3:
    raise SystemExit("Usage: python3 scripts/build-schedule-data.py GTFS.zip public/data/muni-map.json")

feed_path, map_path = sys.argv[1:]
with open(map_path, encoding="utf-8") as stream:
    map_data = json.load(stream)
route_ids = {route["id"] for route in map_data["routes"]}
stop_ids = {stop["id"] for stop in map_data["stops"]}

with zipfile.ZipFile(feed_path) as archive:
    calendars = rows(archive, "calendar.txt")
    exceptions = rows(archive, "calendar_dates.txt")
    trips = rows(archive, "trips.txt")
    stop_times = rows(archive, "stop_times.txt")

# Select the latest Wednesday within the feed's published service window, then
# apply calendar_dates exceptions. The app reuses this typical weekday in its
# synthetic 90-day horizon; it does not pretend to simulate dated service.
latest = max(calendar["end_date"] for calendar in calendars)
candidate = date(int(latest[:4]), int(latest[4:6]), int(latest[6:8]))
while candidate.weekday() != 2:
    candidate -= timedelta(days=1)
service_date = candidate.strftime("%Y%m%d")
day_name = candidate.strftime("%A").lower()
active_services = {
    calendar["service_id"] for calendar in calendars
    if calendar["start_date"] <= service_date <= calendar["end_date"] and calendar[day_name] == "1"
}
for exception in exceptions:
    if exception["date"] != service_date:
        continue
    if exception["exception_type"] == "1":
        active_services.add(exception["service_id"])
    elif exception["exception_type"] == "2":
        active_services.discard(exception["service_id"])

trip_by_id = {
    trip["trip_id"]: trip for trip in trips
    if trip["service_id"] in active_services and trip["route_id"] in route_ids
}
times_by_trip = defaultdict(list)
for stop_time in stop_times:
    trip = trip_by_id.get(stop_time["trip_id"])
    if not trip or stop_time["stop_id"] not in stop_ids:
        continue
    try:
        arrival = minutes(stop_time["arrival_time"])
        departure = minutes(stop_time["departure_time"])
    except (AttributeError, ValueError):
        continue
    if arrival > 19 * 60 + 15 or departure < 10 * 60 + 45:
        continue
    times_by_trip[stop_time["trip_id"]].append((int(stop_time["stop_sequence"]), stop_time["stop_id"], arrival, departure))

scheduled_trips = []
for trip_id, stops in times_by_trip.items():
    stops.sort(key=lambda stop: stop[0])
    if len(stops) < 8:
        continue
    trip = trip_by_id[trip_id]
    scheduled_trips.append({
        "id": trip_id,
        "routeId": trip["route_id"],
        "direction": trip.get("direction_id", "0"),
        "headsign": trip.get("trip_headsign", ""),
        "blockId": trip.get("block_id", ""),
        "stops": [[stop_id, arrival, departure] for _, stop_id, arrival, departure in stops],
    })
scheduled_trips.sort(key=lambda trip: (trip["routeId"], trip["direction"], trip["stops"][0][1], trip["id"]))

output = {
    "source": "SFMTA GTFS static feed",
    "sourceUrl": "https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip",
    "serviceDate": service_date,
    "feedStart": min(calendar["start_date"] for calendar in calendars),
    "feedEnd": latest,
    "weekday": "Wednesday",
    "trips": scheduled_trips,
}
with open("public/data/muni-schedule.json", "w", encoding="utf-8") as stream:
    json.dump(output, stream, separators=(",", ":"))
print(f"Wrote {len(scheduled_trips):,} weekday trips for {service_date} to public/data/muni-schedule.json")
