// Rebuilds a run's report files (proposals, trace, insights, ranking, challenges) from what the run
// saved: board.json, meta.json, trace.jsonl, loops.json and ledger.json. No model calls.
// Run: npm run report -- <run id>
import { existsSync, readFileSync } from "node:fs"
import type { LoopRecord, TraceEvent } from "../src/agents/recorder"
import { loadDataset } from "../src/data/load"
import { Library } from "../src/data/search"
import type { SponaRunner } from "../src/llm/runner"
import { SponaState } from "../src/state"
import { boardFromJson, writeRun } from "../src/trace/report"

const runId = process.argv[2]
const dir = `runs/${runId}`
if (!runId || !existsSync(`${dir}/board.json`)) {
	console.error(`Usage: npm run report -- <run id>. ${dir}/board.json is needed; runs recorded before it existed can't be rebuilt.`)
	process.exit(1)
}
const read = (f: string) => readFileSync(`${dir}/${f}`, "utf-8")
const meta = JSON.parse(read("meta.json"))
const ledger = JSON.parse(read("ledger.json"))
const runner = { stats: () => ledger.stats, ledger: ledger.calls } as unknown as SponaRunner
const ds = loadDataset()
const state = new SponaState(meta.config, ds, new Library(ds), runner, boardFromJson(JSON.parse(read("board.json"))))
const events: TraceEvent[] = read("trace.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const loops = new Map<string, LoopRecord>((JSON.parse(read("loops.json")) as LoopRecord[]).map((l, i) => [String(i), l]))
const { proposalFiles } = writeRun(state, events, loops, { cloudRunUrl: meta.cloudRunUrl, cloudLoopUrls: meta.cloudLoopUrls ?? [], libraryMs: meta.libraryMs })
console.log(`Rebuilt ${dir}/ with ${proposalFiles.length} proposals, no model calls.`)
