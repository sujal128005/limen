# Testing a real model: Gemini and local Gemma 3

The engine was built and verified with the deterministic stub. The two real-model adapters in
`limen/llm.py` have **not** been run against a live model yet. These are the steps to do that.

What the check does: `scripts/check_llm.py` sends the synthetic HDPE tender from `data/` to the model, shows
what came back, shows which values survived the grounding check, and compares the resulting requirement
with the reference. Only synthetic text is sent.

Do the one-time setup first (`bash setup.sh`, or `setup.bat` on Windows). Run every command below from the
`limen-core` folder. On Windows use `.venv\Scripts\python` instead of `.venv/bin/python`.

---

## A. Gemini

**Step 1. Get an API key.** Open Google AI Studio (aistudio.google.com), sign in, choose "Get API key",
create a key and copy it. Do not commit it or paste it into chat.

**Step 2. Set the two variables.**

macOS / Linux:

```bash
export LIMEN_LLM=gemini
export GEMINI_API_KEY="paste-your-key-here"
```

Windows PowerShell:

```powershell
$env:LIMEN_LLM = "gemini"
$env:GEMINI_API_KEY = "paste-your-key-here"
```

**Step 3. Run the check.**

```bash
.venv/bin/python scripts/check_llm.py
```

**Step 4. Read the last line.**

| Last line | Meaning | What to do |
|---|---|---|
| `RESULT: PASS` | Connection works and the extraction matches the reference | Go to step 5 |
| `RESULT: connection works, but N field(s) differ` | The model answers, but formats a value differently | Send me the full output; the prompt or normalisation needs a small change |
| `FAIL ... HTTP 400` with "API key not valid", or `HTTP 401` / `403` | Key is wrong, or the Generative Language API is not enabled for it | Recreate the key in AI Studio and set it again |
| `FAIL ... HTTP 404` | The model name is not available to your key | Pick a current model name in AI Studio and set `LIMEN_GEMINI_MODEL` (see below), then rerun |
| `FAIL ... HTTP 429` | Rate or quota limit | Wait a minute and rerun, or check the quota in AI Studio |
| `FAIL ... could not be reached` | Network or proxy problem | Check internet access from that machine |
| `FAIL ... not a JSON object` | The model replied with something other than JSON | Send me the output |

The adapter uses `gemini-2.5-flash` unless told otherwise. To use another model:

```bash
export LIMEN_GEMINI_MODEL="the-model-name-shown-in-ai-studio"
```

**Step 5. Run the whole flow through the service with Gemini.** In one terminal (same variables set):

```bash
.venv/bin/python -m limen.service --port 8088
```

In a second terminal:

```bash
.venv/bin/python examples/run_e2e.py --http http://127.0.0.1:8088 > gemini_run.txt
```

```bash
diff gemini_run.txt examples/expected_output.txt && echo "IDENTICAL to the reference run"
```

`IDENTICAL` means Gemini's extraction produced exactly the same requirement, shortlist, recommendation and
negotiation as the reference. If `diff` prints lines, send them to me: differences should only appear in
section 1 (the parsed requirement) and whatever follows from it.

---

## B. Gemma 3 on your own machine (through Ollama)

Nothing leaves your machine in this mode.

**Step 1. Install Ollama** from ollama.com and start it.

**Step 2. Download Gemma 3.** The default tag is a few GB; larger variants (`gemma3:12b`, `gemma3:27b`)
extract more reliably if the machine has the memory.

```bash
ollama pull gemma3
```

**Step 3. Confirm it is running.**

```bash
ollama list
```

**Step 4. Set the variables.**

macOS / Linux:

```bash
export LIMEN_LLM=ollama
export LIMEN_OLLAMA_MODEL=gemma3
```

Windows PowerShell:

```powershell
$env:LIMEN_LLM = "ollama"
$env:LIMEN_OLLAMA_MODEL = "gemma3"
```

If Ollama runs on another host or port, also set `LIMEN_OLLAMA_URL` (default `http://localhost:11434`).

**Step 5. Run the check.** The first call can take a minute while the model loads.

```bash
.venv/bin/python scripts/check_llm.py
```

**Step 6. Read the last line** using the table in A, step 4. Two cases specific to Ollama:

| Last line | What to do |
|---|---|
| `FAIL ... could not be reached` | Ollama is not running, or `LIMEN_OLLAMA_URL` is wrong |
| `FAIL ... HTTP 404` | The model tag is not downloaded; run `ollama pull` for the tag in `LIMEN_OLLAMA_MODEL` |

**Step 7. Full flow.** Same as A, step 5.

---

## What to send back

For each model: the complete output of `scripts/check_llm.py`, and the `diff` output from the full-flow
step if it was not identical. That is enough to fix any mismatch.

## Good to know

* Whatever a model returns passes the same grounding check as the stub. A value without verbatim supporting
  text is discarded and reported, so a weak model produces more questions for the user, not wrong numbers.
* A model can never set or change the ceiling or the floor; those only come from the Head and the Owner.
* If the model cannot be reached while the service is running, the parse and profile endpoints return
  HTTP 502 `LLM_UNAVAILABLE`. All other endpoints do not use the model at all.
* With Gemini, real tender text leaves your infrastructure. With local Gemma it does not.
* To go back to the stub: unset `LIMEN_LLM` (or set it to `stub`).
