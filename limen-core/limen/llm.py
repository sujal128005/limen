"""Pluggable language layer.

The LLM does exactly one job: read text and return *mentions* -
(field, raw value, verbatim evidence). It never calculates, ranks, decides,
or sets a limit. Everything it returns is treated as an untrusted claim and
must pass the grounding check in limen.extraction before it is used.

Implementations:
* ``StubLLM``     - deterministic, rule-based; used by tests and the example.
* ``ScriptedLLM`` - returns canned mentions; used to test how the engine
                    handles a model that hallucinates.
* ``GeminiLLM`` / ``OllamaLLM`` - thin HTTP adapters for Gemini and for a
                    local Gemma 3 served by Ollama. Not exercised by the test
                    suite; wire them in with ``LIMEN_LLM=gemini|ollama``.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Protocol

from . import geo
from .catalog import CERTIFICATIONS, MATERIALS

Mention = dict[str, Any]  # {"field": str, "value": Any, "evidence": str}

FIELD_GUIDE = {
    "material": "one of: " + ", ".join(MATERIALS),
    "quantity": '{"amount": number, "unit": "KG" | "MT" | "PCS"}',
    "delivery_city": "city the goods must be delivered to",
    "city": "city where the supplier's plant is (supplier profiles only)",
    "need_by_days": "integer days from now by which delivery is needed",
    "certification": "one of: " + ", ".join(CERTIFICATIONS),
    "credit_days": "integer payment credit period in days",
    "budget_inr": "any budget or target price in rupees (kept private)",
    "moq": '{"amount": number, "unit": ...} minimum order quantity (supplier profiles only)',
    "monthly_capacity": '{"amount": number, "unit": ...} per month (supplier profiles only)',
    "lead_time_days": "integer standard lead time in days (supplier profiles only)",
    "spec.<attribute>": '{"min": number|null, "max": number|null} or {"value": string}; attributes: '
                        + ", ".join(sorted({a for m in MATERIALS.values() for a in m.attrs})),
}


class LLMClient(Protocol):
    def extract(self, task: str, text: str) -> list[Mention]:
        """Return mentions found in ``text``. ``task`` is "requirement" or
        "supplier_profile". ``evidence`` must be copied verbatim from the text."""
        ...


# --------------------------------------------------------------------------- deterministic stub
_NUM = r"(\d[\d,]*(?:\.\d+)?)"
_UNIT = r"(mt|metric\s+tonn?es?|metric\s+tons?|tonn?es?|tons?|kgs?|kilograms?|pcs|pieces|nos\.?|units|boxes|cartons)"
_UNIT_MAP = {"mt": "MT", "metric": "MT", "tonne": "MT", "tonnes": "MT", "ton": "MT", "tons": "MT",
             "kg": "KG", "kgs": "KG", "kilogram": "KG", "kilograms": "KG"}
_RANGE = r"(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)"

_GRADE_TYPES = [("blow_moulding", r"blow[\s-]*mou?ld(?:ing)?"), ("injection_moulding", r"injection[\s-]*mou?ld(?:ing)?"),
                ("raffia", r"raffia"), ("pipe", r"pipe\s+grade"), ("film", r"film\s+grade"),
                ("roto_moulding", r"roto[\s-]*mou?ld(?:ing)?")]
_STEEL_GRADES = [(r"IS\s*2062\s*E\s*(250|350)", "IS2062_E{}"), (r"IS\s*513\s*CR\s*([1-4])", "IS513_CR{}"),
                 (r"IS\s*(10748)", "IS{}"), (r"SAE\s*(1010)", "SAE{}")]


def _f(x: str) -> float:
    return float(x.replace(",", ""))


def _unit(raw: str) -> str:
    return _UNIT_MAP.get(raw.lower().split()[0].rstrip("."), "PCS")


class StubLLM:
    """Rule-based extractor. Deterministic by construction."""

    def extract(self, task: str, text: str) -> list[Mention]:
        out: list[Mention] = []
        add = lambda field, value, m: out.append({"field": field, "value": value, "evidence": m.group(0)})  # noqa: E731
        I = re.IGNORECASE

        for name, mdef in sorted(MATERIALS.items(), key=lambda kv: -max(len(a) for a in kv[1].aliases)):
            for alias in sorted(mdef.aliases, key=len, reverse=True):
                m = re.search(rf"(?<![A-Za-z]){re.escape(alias)}(?![A-Za-z])", text, I)
                if m:
                    add("material", name, m)
                    break

        special = r"(moq|minimum\s+order(?:\s+quantity)?|capacity)\D{0,25}" + _NUM + r"\s*" + _UNIT
        taken: list[tuple[int, int]] = []
        for m in re.finditer(special, text, I):
            kind = "monthly_capacity" if m.group(1).lower() == "capacity" else "moq"
            add(kind, {"amount": _f(m.group(2)), "unit": _unit(m.group(3))}, m)
            taken.append(m.span())
        for m in re.finditer(_NUM + r"\s*" + _UNIT + r"(?![A-Za-z])", text, I):
            if any(a <= m.start() < b for a, b in taken):
                continue
            if re.search(r"(per\s+month|/\s*month|monthly)", text[m.end():m.end() + 15], I):
                add("monthly_capacity", {"amount": _f(m.group(1)), "unit": _unit(m.group(2))}, m)
            else:
                add("quantity", {"amount": _f(m.group(1)), "unit": _unit(m.group(2))}, m)

        cities = "|".join(sorted(geo.CITIES, key=len, reverse=True))
        for m in re.finditer(rf"(?:deliver(?:y|ed|ies)?|ship(?:ped)?|supply)\b[^.\n]{{0,50}}?\b({cities})\b", text, I):
            add("delivery_city", m.group(1).title(), m)
        for m in re.finditer(rf"(?:for|at)\s+(?:our\s+)?({cities})\s+(?:plant|unit|factory|works)", text, I):
            add("delivery_city", m.group(1).title(), m)
        for m in re.finditer(rf"(?:based|located|plant|factory|works|unit)\s+(?:in|at)\s+({cities})\b", text, I):
            add("city", m.group(1).title(), m)

        for m in re.finditer(r"(?:lead\s*time)\D{0,20}(\d+)\s*(day|week)s?", text, I):
            add("lead_time_days", int(m.group(1)) * (7 if m.group(2).lower() == "week" else 1), m)
            taken.append(m.span())
        for m in re.finditer(r"(?:within|in|by)\s+(\d+)\s*(day|week)s?", text, I):
            if not any(a <= m.start() < b for a, b in taken):
                add("need_by_days", int(m.group(1)) * (7 if m.group(2).lower() == "week" else 1), m)

        for name, aliases in CERTIFICATIONS.items():
            for alias in aliases:
                m = re.search(rf"(?<![A-Za-z]){re.escape(alias)}(?![A-Za-z0-9])", text, I)
                if m:
                    add("certification", name, m)
                    break

        for pat in (r"(\d+)\s*days?\s*(?:credit|payment)", r"(?:credit|payment)(?:\s+(?:period|terms?))?\D{0,12}(\d+)\s*days?"):
            for m in re.finditer(pat, text, I):
                add("credit_days", int(m.group(1)), m)

        for m in re.finditer(r"(?:budget|target\s+price)[^.\n]{0,30}?(?:rs\.?|inr|₹)\s*" + _NUM
                             + r"\s*(lakhs?|crores?|cr)?", text, I):
            mult = {"l": 100_000, "c": 10_000_000}.get((m.group(2) or " ")[0].lower(), 1)
            add("budget_inr", _f(m.group(1)) * mult, m)

        # specifications
        for label, attr in ((r"(?:mfi|melt\s+flow(?:\s+index)?)", "mfi_g_10min"), (r"density", "density_g_cc")):
            for m in re.finditer(label + r"\D{0,15}?" + _RANGE, text, I):
                add(f"spec.{attr}", {"min": float(m.group(1)), "max": float(m.group(2))}, m)
            for m in re.finditer(label + r"\D{0,15}?(\d+(?:\.\d+)?)(?!\s*(?:-|–|to)\s*\d)(?![\d.])", text, I):
                if not re.match(label + r"\D{0,15}?" + _RANGE, text[m.start():], I):
                    add(f"spec.{attr}", {"min": float(m.group(1)), "max": float(m.group(1))}, m)
        for value, pat in _GRADE_TYPES:
            m = re.search(pat, text, I)
            if m:
                add("spec.grade_type", {"value": value}, m)
        for pat, fmt in _STEEL_GRADES:
            for m in re.finditer(pat, text, I):
                add("spec.steel_grade", {"value": fmt.format(m.group(1))}, m)
        for m in re.finditer(r"(?:thickness\D{0,10}(\d+(?:\.\d+)?)\s*mm|(\d+(?:\.\d+)?)\s*mm\s*(?:thick|thk))", text, I):
            v = float(m.group(1) or m.group(2))
            add("spec.thickness_mm", {"min": v, "max": v}, m)
        for m in re.finditer(r"(?:width\D{0,10}(\d+)\s*mm|(\d+)\s*mm\s*(?:wide|width))", text, I):
            v = float(m.group(1) or m.group(2))
            add("spec.width_mm", {"min": v, "max": v}, m)
        for m in re.finditer(r"(?:purity\D{0,12}(\d{2}(?:\.\d+)?)|(\d{2}(?:\.\d+)?)\s*%\s*(?:purity|pure|min))", text, I):
            add("spec.purity_pct", {"min": float(m.group(1) or m.group(2)), "max": None}, m)
        for m in re.finditer(r"(\d)\s*-?\s*ply", text, I):
            add("spec.ply", {"min": float(m.group(1)), "max": float(m.group(1))}, m)
        for m in re.finditer(r"(\d+)\s*[x×*]\s*(\d+)\s*[x×*]\s*(\d+)\s*mm", text, I):
            for attr, g in (("length_mm", 1), ("width_mm", 2), ("height_mm", 3)):
                add(f"spec.{attr}", {"min": float(m.group(g)), "max": float(m.group(g))}, m)
        for m in re.finditer(r"bursting\s+strength\D{0,15}(\d+(?:\.\d+)?)", text, I):
            add("spec.bursting_strength_kg_cm2", {"min": float(m.group(1)), "max": None}, m)
        for m in re.finditer(r"(\d+)\s*(?:micron|mic\b|µ)", text, I):
            add("spec.thickness_micron", {"min": float(m.group(1)), "max": float(m.group(1))}, m)
        return out


class ScriptedLLM:
    """Returns exactly the mentions it was given (for hallucination tests)."""

    def __init__(self, mentions: list[Mention]):
        self._mentions = mentions

    def extract(self, task: str, text: str) -> list[Mention]:
        return [dict(m) for m in self._mentions]


# --------------------------------------------------------------------------- real model adapters
def build_prompt(task: str, text: str) -> str:
    return (
        "You extract procurement facts from text. Return ONLY JSON of the form "
        '{"mentions": [{"field": str, "value": any, "evidence": str}]}.\n'
        "Rules: 'evidence' must be copied character-for-character from the text. "
        "Report a fact only if the text states it. Never infer, convert units or fill gaps. "
        "If a fact appears twice with different values, report both.\n"
        f"Task: {task}\nFields:\n" + "\n".join(f"- {k}: {v}" for k, v in FIELD_GUIDE.items())
        + f"\n\nText:\n<<<\n{text}\n>>>"
    )


class LLMError(RuntimeError):
    """The model could not be reached or did not return usable JSON."""


def _post_json(url: str, body: dict, headers: dict[str, str], timeout: int = 120) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise LLMError(f"model endpoint returned HTTP {e.code}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise LLMError(f"model endpoint could not be reached: {e}") from e


def _mentions_from(raw: str) -> list[Mention]:
    """Parse the model's reply. Tolerates code fences or prose around the JSON object."""
    text = raw.strip()
    start, end = text.find("{"), text.rfind("}")
    try:
        data = json.loads(text[start:end + 1]) if start != -1 and end > start else None
    except ValueError:
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("mentions"), list):
        raise LLMError("model reply was not a JSON object with a 'mentions' list")
    return [m for m in data["mentions"] if isinstance(m, dict) and {"field", "value", "evidence"} <= m.keys()]


class GeminiLLM:
    def __init__(self, model: str | None = None, api_key: str | None = None):
        self.model = model or os.environ.get("LIMEN_GEMINI_MODEL", "gemini-2.5-flash")
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY", "")

    def extract(self, task: str, text: str) -> list[Mention]:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        body = {"contents": [{"parts": [{"text": build_prompt(task, text)}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0}}
        out = _post_json(url, body, {"x-goog-api-key": self.api_key})
        try:
            reply = out["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"unexpected Gemini response shape: {str(out)[:300]}") from e
        return _mentions_from(reply)


class OllamaLLM:
    """Local Gemma 3 through Ollama's HTTP API."""

    def __init__(self, model: str | None = None, base_url: str | None = None):
        self.model = model or os.environ.get("LIMEN_OLLAMA_MODEL", "gemma3")
        self.base_url = base_url or os.environ.get("LIMEN_OLLAMA_URL", "http://localhost:11434")

    def extract(self, task: str, text: str) -> list[Mention]:
        body = {"model": self.model, "prompt": build_prompt(task, text), "format": "json", "stream": False,
                "options": {"temperature": 0}}
        out = _post_json(f"{self.base_url}/api/generate", body, {})
        if not isinstance(out.get("response"), str):
            raise LLMError(f"unexpected Ollama response shape: {str(out)[:300]}")
        return _mentions_from(out["response"])


def llm_from_env() -> LLMClient:
    kind = os.environ.get("LIMEN_LLM", "stub").lower()
    return {"gemini": GeminiLLM, "ollama": OllamaLLM}.get(kind, StubLLM)()
