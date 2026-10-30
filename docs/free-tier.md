# Running on the Gemini free tier

Spona was built and run on a free Gemini API key. What we measured on 30 October 2026, and how the design follows from it.

## What the free tier allows

- The flash models (`gemini-3.5-flash`, `gemini-3.8-flash`, `gemini-3-flash-preview`, and `gemini-3.6-flash`, which serves `gemini-3.5-flash`) allow **20 requests per day each**. The 429 says so: quota id `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, value `20`. Failed and timed-out attempts seem to count too.
- `gemini-3.5-flash-lite` took more than 100 requests in a day without a 429, so its daily limit is much higher.
- Daily quotas reset at midnight Pacific time (07:00 UTC in October).
- `gemini-3.8-flash` answered 503 ("high demand") for long stretches. `gemini-3.7-flash` and the `gemini-flash-latest` alias didn't answer within 45 seconds. `gemini-2.5-flash`, `-flash-lite` and `-pro` return 404 for new users. `gemini-3.1-pro-preview` has no free quota. Gemma 4 returned 500 on JSON output.

`scripts/probe-models.ts` sends one tiny request per model through Mozaik's Gemini endpoint and prints what works.

## What Spona does about it

- **Search first.** The library indexes the whole dataset with BM25 in about 7 seconds. Matching, ranking, deduplication, availability and most of the critic's checks are rules over that index. Models only see what search surfaced.
- **Many small jobs go to flash-lite, the few that need judgement go to a stronger model.** Analysts and profilers use `gemini-3.5-flash-lite`. The critic's model check and the writer use Claude Sonnet 4.6 when the hackathon's gateway key is set (`JIGJOY_ANTHROPIC_*`), and Gemini flash models otherwise, with the flash models as fallback either way.
- **Batching.** Ten companies per analyst call, four pairs per profiler call, up to eight evidence cards per critic call. Returned items are collected for a few seconds and revised in one call.
- **Fallback chains.** Each role has a list of free models. When one is out of daily quota, overloaded or silent for two minutes, the runner moves to the next and records the switch in the ledger. Exhausted models are remembered in `.cache/quota.json` until they reset, so the next run doesn't waste requests on them.
- **A hard cap.** `--max-calls` (default 120) stops the run from spending more. When the cap is hit, agents get an error answer and fall back: claims that can't be checked don't pass.
- **A cache.** Answers are cached by prompt in `.cache/llm/`, so rerunning after a crash only pays for what didn't finish. `--fresh` ignores it; the recorded runs in `runs/` used `--fresh`.

A full run on all 153 companies needs about 50 requests, most of them on flash-lite.
