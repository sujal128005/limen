"""Live check of a real model (Gemini, or local Gemma 3 through Ollama).

    LIMEN_LLM=gemini GEMINI_API_KEY=...  python scripts/check_llm.py
    LIMEN_LLM=ollama                     python scripts/check_llm.py

Sends the synthetic HDPE tender to the model and reports:
  1. what the model returned (mentions),
  2. how many mentions survived the grounding check,
  3. the resulting requirement next to the deterministic stub's.
Only synthetic text from data/ leaves your machine.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from limen.extraction import extract_requirement, is_grounded  # noqa: E402
from limen.llm import LLMError, ScriptedLLM, StubLLM, llm_from_env  # noqa: E402

FIELDS = ("material", "quantity", "uom", "delivery_city", "need_by_days", "preferred_credit_days",
          "required_certifications")


def summary(req) -> dict:
    out = {f: getattr(req, f) for f in FIELDS}
    out["specs"] = {k: (v.one_of or [v.min, v.max]) for k, v in sorted(req.specs.items())}
    return out


def main() -> int:
    kind = os.environ.get("LIMEN_LLM", "stub").lower()
    llm = llm_from_env()
    name = f"{type(llm).__name__} (model: {getattr(llm, 'model', 'n/a')})"
    if kind not in ("gemini", "ollama"):
        print("LIMEN_LLM is not set to 'gemini' or 'ollama'; nothing to check. See docs/LLM_TESTING.md.")
        return 2
    text = json.loads((ROOT / "data" / "synthetic_dataset.json").read_text())["requests"]["hdpe_tender"]
    print(f"Model under test: {name}\n")
    started = time.time()
    try:
        mentions = llm.extract("requirement", text)
    except LLMError as e:
        print(f"FAIL - could not get a usable reply: {e}")
        return 1
    print(f"1. Model replied in {time.time() - started:.1f}s with {len(mentions)} mentions:")
    grounded = 0
    for m in mentions:
        ok = is_grounded(m, text)
        grounded += ok
        print(f"   [{'grounded ' if ok else 'DISCARDED'}] {m['field']:<24} {json.dumps(m['value'])}   <- \"{m['evidence']}\"")
    print(f"\n2. Grounding: {grounded} kept, {len(mentions) - grounded} discarded (discarded values are never used).")

    got = summary(extract_requirement(text, ScriptedLLM(mentions), "REQ-CHECK", "BUY-001", "Pune"))
    want = summary(extract_requirement(text, StubLLM(), "REQ-CHECK", "BUY-001", "Pune"))
    print("\n3. Requirement built from the model vs the reference (stub):")
    mismatches = 0
    for key in want:
        same = got[key] == want[key]
        mismatches += not same
        print(f"   {'ok      ' if same else 'DIFFERS '} {key:<24} model={got[key]!r}" + ("" if same else f"   reference={want[key]!r}"))
    if mismatches:
        print(f"\nRESULT: connection works, but {mismatches} field(s) differ from the reference. "
              "Send me this output and I will adjust the prompt or the value normalisation.")
        return 1
    print("\nRESULT: PASS - connection works and the model's extraction matches the reference.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
