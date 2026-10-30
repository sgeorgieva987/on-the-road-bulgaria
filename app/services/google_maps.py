"""Thin integration with the Google Maps Platform Routes API.

The Routes API key is server-side only. The browser receives a separate,
referrer-restricted Maps JavaScript API key via /api/config.
"""
from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.core.config import settings
from app.models import Destination

ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"


class GoogleRoutesError(RuntimeError):
    """Raised when Google's routing service cannot return a usable route."""


@dataclass
class GoogleRouteResult:
    ordered_destinations: list[Destination]
    leg_distance_km: list[float]
    leg_travel_minutes: list[int]
    total_distance_km: float
    total_travel_minutes: int
    encoded_polyline: str | None


def _point(latitude: float, longitude: float) -> dict:
    return {"location": {"latLng": {"latitude": latitude, "longitude": longitude}}}


def _duration_minutes(value: str | None) -> int:
    if not value:
        return 0
    # Routes API expresses durations as protobuf values such as "123s".
    try:
        return max(0, round(float(value.removesuffix("s")) / 60))
    except (AttributeError, TypeError, ValueError):
        return 0


def build_google_maps_url(
    start_latitude: float,
    start_longitude: float,
    destinations: list[Destination],
    *,
    transport_mode: str,
    return_to_start: bool,
) -> str | None:
    """Create a shareable Google Maps Directions URL with ordered coordinates.

    Maps URLs do not require an API key. The UI limits manually selected stops
    to nine so a return-to-start route fits the documented waypoint limit.
    """
    if not destinations:
        return None

    origin = f"{start_latitude:.6f},{start_longitude:.6f}"
    start = origin
    travelmode = "walking" if transport_mode == "walking" else "driving"
    if return_to_start:
        destination = start
        waypoints = [f"{d.latitude:.6f},{d.longitude:.6f}" for d in destinations]
        waypoint_place_ids = [d.google_place_id for d in destinations]
    else:
        destination = f"{destinations[-1].latitude:.6f},{destinations[-1].longitude:.6f}"
        waypoints = [f"{d.latitude:.6f},{d.longitude:.6f}" for d in destinations[:-1]]
        waypoint_place_ids = [d.google_place_id for d in destinations[:-1]]

    params = {"api": "1", "origin": origin, "destination": destination, "travelmode": travelmode}
    if waypoints:
        params["waypoints"] = "|".join(waypoints)
    if destinations[-1].google_place_id and not return_to_start:
        params["destination_place_id"] = destinations[-1].google_place_id
    if waypoint_place_ids and all(waypoint_place_ids):
        params["waypoint_place_ids"] = "|".join(waypoint_place_ids)
    # Keep this URL stable/shareable; coordinates identify the saved destinations.
    return "https://www.google.com/maps/dir/?" + urlencode(params)


def compute_google_route(
    start_latitude: float,
    start_longitude: float,
    destinations: list[Destination],
    *,
    transport_mode: str,
    return_to_start: bool,
) -> GoogleRouteResult | None:
    """Call Compute Routes and return route metrics with the optimized stop order.

    Returns None when no server-side key is configured. It deliberately does not
    call geocoding: the source-of-truth coordinates already live in our database.
    """
    api_key = settings.google_routes_api_key
    if not api_key:
        return None
    if not destinations:
        raise GoogleRoutesError("At least one destination is required to calculate a route.")

    start_point = _point(start_latitude, start_longitude)
    if return_to_start:
        destination_point = start_point
        intermediate_destinations = list(destinations)
    else:
        destination_point = _point(destinations[-1].latitude, destinations[-1].longitude)
        intermediate_destinations = list(destinations[:-1])

    body: dict = {
        "origin": start_point,
        "destination": destination_point,
        "travelMode": "WALK" if transport_mode == "walking" else "DRIVE",
        "languageCode": "bg",
        "units": "METRIC",
    }
    if intermediate_destinations:
        body["intermediates"] = [_point(d.latitude, d.longitude) for d in intermediate_destinations]
    # Compute Routes can optimize intermediate stopovers. In a one-way route,
    # the last chosen destination remains the fixed endpoint; for a loop all
    # selected places are intermediates and can be reordered.
    if body["travelMode"] == "DRIVE" and len(intermediate_destinations) >= 2:
        body["optimizeWaypointOrder"] = True

    fields = [
        "routes.distanceMeters",
        "routes.duration",
        "routes.legs.distanceMeters",
        "routes.legs.duration",
        "routes.polyline.encodedPolyline",
    ]
    if body.get("optimizeWaypointOrder"):
        fields.append("routes.optimizedIntermediateWaypointIndex")

    try:
        response = httpx.post(
            ROUTES_ENDPOINT,
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": api_key,
                "X-Goog-FieldMask": ",".join(fields),
            },
            json=body,
            timeout=20.0,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        detail = ""
        response = getattr(exc, "response", None)
        if response is not None:
            try:
                error_payload = response.json().get("error", {})
                status = error_payload.get("status")
                message = error_payload.get("message")
                if status or message:
                    detail = f" [{status or 'Google error'}: {message or 'no message'}]"
            except (ValueError, AttributeError):
                pass
        message = (
            "Google Routes API permission denied. In Google Cloud, enable Routes API, attach billing, and ensure this server key "
            "is restricted to Routes API. Backend keys must use IP/none application restrictions, not HTTP referrers."
        )
        raise GoogleRoutesError(message + detail) from exc

    routes = payload.get("routes") or []
    if not routes:
        raise GoogleRoutesError("Google Maps did not return a route for these locations.")
    route = routes[0]
    raw_legs = route.get("legs") or []
    if len(raw_legs) < len(destinations):
        raise GoogleRoutesError("Google Maps returned incomplete route-leg information.")

    optimized_indices = route.get("optimizedIntermediateWaypointIndex") or list(range(len(intermediate_destinations)))
    if intermediate_destinations:
        ordered_intermediates = [intermediate_destinations[i] for i in optimized_indices if 0 <= i < len(intermediate_destinations)]
        if len(ordered_intermediates) != len(intermediate_destinations):
            raise GoogleRoutesError("Google Maps returned an invalid optimized stop order.")
    else:
        ordered_intermediates = []

    if return_to_start:
        ordered_destinations = ordered_intermediates
    else:
        ordered_destinations = ordered_intermediates + [destinations[-1]]

    # Route legs follow the returned optimized waypoint order: one leg per stop,
    # plus a final return leg for a loop. Destination-level leg data excludes that
    # final return leg; route totals include it.
    leg_distance_km = [round(float(leg.get("distanceMeters", 0)) / 1000, 1) for leg in raw_legs[:len(destinations)]]
    leg_travel_minutes = [_duration_minutes(leg.get("duration")) for leg in raw_legs[:len(destinations)]]
    total_distance_km = round(float(route.get("distanceMeters", 0)) / 1000, 1)
    total_travel_minutes = _duration_minutes(route.get("duration"))
    polyline = (route.get("polyline") or {}).get("encodedPolyline")

    if len(ordered_destinations) != len(destinations):
        raise GoogleRoutesError("Google Maps returned a different number of stops than requested.")

    return GoogleRouteResult(
        ordered_destinations=ordered_destinations,
        leg_distance_km=leg_distance_km,
        leg_travel_minutes=leg_travel_minutes,
        total_distance_km=total_distance_km,
        total_travel_minutes=total_travel_minutes,
        encoded_polyline=polyline,
    )
