"""City lookup and road-distance estimate.

Distances are ESTIMATED (great-circle x a road factor). Replace with a routing
API or the buyer's own freight contracts when available; a supplier's quoted
freight always overrides an estimate.
"""
from __future__ import annotations

import math

ROAD_FACTOR = 1.25          # DEFAULT_ASSUMPTION: road km / great-circle km
TRANSIT_KM_PER_DAY = 400    # DEFAULT_ASSUMPTION: truck transit speed

# city -> (latitude, longitude, state)
CITIES: dict[str, tuple[float, float, str]] = {
    "Pune": (18.52, 73.86, "Maharashtra"),
    "Mumbai": (19.08, 72.88, "Maharashtra"),
    "Nashik": (20.00, 73.79, "Maharashtra"),
    "Aurangabad": (19.88, 75.34, "Maharashtra"),
    "Nagpur": (21.15, 79.09, "Maharashtra"),
    "Ahmedabad": (23.02, 72.57, "Gujarat"),
    "Vadodara": (22.31, 73.18, "Gujarat"),
    "Surat": (21.17, 72.83, "Gujarat"),
    "Rajkot": (22.30, 70.80, "Gujarat"),
    "Vapi": (20.37, 72.90, "Gujarat"),
    "Indore": (22.72, 75.86, "Madhya Pradesh"),
    "Hyderabad": (17.39, 78.49, "Telangana"),
    "Bengaluru": (12.97, 77.59, "Karnataka"),
    "Chennai": (13.08, 80.27, "Tamil Nadu"),
    "Coimbatore": (11.02, 76.96, "Tamil Nadu"),
    "Delhi": (28.61, 77.21, "Delhi"),
    "Faridabad": (28.41, 77.31, "Haryana"),
    "Gurugram": (28.46, 77.03, "Haryana"),
    "Ludhiana": (30.90, 75.85, "Punjab"),
    "Jaipur": (26.91, 75.79, "Rajasthan"),
    "Kolkata": (22.57, 88.36, "West Bengal"),
    "Jamshedpur": (22.80, 86.20, "Jharkhand"),
    "Raipur": (21.25, 81.63, "Chhattisgarh"),
    "Visakhapatnam": (17.69, 83.22, "Andhra Pradesh"),
}


def state_of(city: str | None) -> str | None:
    entry = CITIES.get(city or "")
    return entry[2] if entry else None


def road_km(city_a: str | None, city_b: str | None) -> int | None:
    """Estimated road distance in km, or None if either city is unknown."""
    a, b = CITIES.get(city_a or ""), CITIES.get(city_b or "")
    if a is None or b is None:
        return None
    if city_a == city_b:
        return 25  # local delivery
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return int(round(2 * 6371 * math.asin(math.sqrt(h)) * ROAD_FACTOR))


def transit_days(km: int | None) -> int | None:
    return None if km is None else max(1, math.ceil(km / TRANSIT_KM_PER_DAY))


def freight_per_unit_paise(km: int, unit_weight_kg: float, rate_paise_per_tonne_km: int) -> int:
    """Freight per unit for a given distance: rate x km x tonnes per unit."""
    return int(round(rate_paise_per_tonne_km * km * unit_weight_kg / 1000))
