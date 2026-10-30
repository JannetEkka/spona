import "dotenv/config"
import { appendFileSync, mkdirSync } from "node:fs"
import { parseArgs } from "node:util"
import { createAnalyst } from "./agents/analyst"
import { createCoordinator } from "./agents/coordinator"
import { createCritic } from "./agents/critic"
import { createMatchmaker } from "./agents/matchmaker"
import { createProfiler } from "./agents/profiler"
import { createCloudRelay, createRecorder } from "./agents/recorder"
import { createWriter } from "./agents/writer"
import { claudeGateway, defaultConfig, LIMITS, MODELS, POOLS } from "./config"
import { loadDataset } from "./data/load"
import { Library } from "./data/search"
import { SponaRunner } from "./llm/runner"
import { emit, initializeRuntime, join } from "./runtime"
import { SponaState, type Board } from "./state"
import { writeRun } from "./trace/report"

const { values: args } = parseArgs({
	options: {
		companies: { type: "string" },
		proposals: { type: "string" },
		"profile-budget": { type: "string" },
		"max-calls": { type: "string" },
		"run-id": { type: "string" },
		fresh: { type: "boolean", default: false },
		approve: { type: "boolean", default: false },
	},
})

// This entry's key, passed to Mozaik's Gemini endpoint explicitly. GEMINI_API_KEY belongs to
// something else, so it is removed from this process before anything can fall back to it.
const apiKey = process.env.GEMINI_API_KEY_NTP
if (!apiKey) {
	console.error("Set GEMINI_API_KEY_NTP (a Gemini API key from AI Studio). See .env.example.")
	process.exit(1)
}
delete process.env.GEMINI_API_KEY

// Mozaik opens one cloud session per agent loop and prints its URL; keep them for the trace.
const cloudLoopUrls: string[] = []
const print = console.log.bind(console)
console.log = (...parts: unknown[]) => {
	const first = String(parts[0] ?? "")
	if (first.startsWith("▶ mozaik cloud")) cloudLoopUrls.push(first.split(" ").pop()!)
	else print(...parts)
}
process.on("unhandledRejection", (e) => print("unhandled:", e))

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")
const config = defaultConfig(args["run-id"] ?? `${stamp}${args.companies ? `-c${args.companies}` : "-full"}`)
if (args.companies) config.companies = Number(args.companies)
if (args.proposals) config.proposals = Number(args.proposals)
if (args["profile-budget"]) config.profileBudget = Number(args["profile-budget"])
if (args["max-calls"]) config.maxCalls = Number(args["max-calls"])
config.cache = !args.fresh
config.approve = args.approve

print(`Spona · run ${config.runId}`)
mkdirSync(config.outDir, { recursive: true })
const liveLedger = `${config.outDir}/ledger.live.jsonl`
const t0 = Date.now()
const ds = loadDataset()
const lib = new Library(ds)
const libraryMs = Date.now() - t0
print(`library: ${ds.researchers.length} researchers, ${ds.publications.size} publications, ${ds.companies.length} companies indexed in ${(libraryMs / 1000).toFixed(1)} s (no model calls)`)

const gateway = claudeGateway()
print(`models: analysts and profilers ${MODELS.fast}; critic ${MODELS.judge}; writer ${MODELS.writer}${gateway ? " (Claude through the JigJoy gateway)" : ""}`)
const runner = new SponaRunner({
	apiKey,
	anthropic: gateway,
	pools: POOLS,
	limits: LIMITS,
	maxCalls: config.maxCalls,
	timeoutMs: 120_000,
	cacheDir: config.cache ? ".cache/llm" : undefined,
	quotaFile: ".cache/quota.json",
	onCall: (e) => appendFileSync(liveLedger, JSON.stringify(e) + "\n"),
	onRetry: (r) => print(`        runner      ${r.model} answered ${r.status}${r.daily ? " (daily quota)" : ""}${r.waitMs ? `, waiting ${Math.round(r.waitMs / 1000)} s` : ""}: ${r.message.slice(0, 120)}`),
})
const board: Board = {
	runId: config.runId,
	startedAt: Date.now(),
	shards: {},
	owner: new Map(),
	cards: new Map(),
	pairs: new Map(),
	proposals: new Map(),
	interventions: [],
	selected: [],
	analystsDone: new Set(),
	challengesTotal: 0,
	profileBudget: config.profileBudget,
	profilesStarted: 0,
	finished: false,
}
const state = new SponaState(config, ds, lib, runner, board)
initializeRuntime({ state, inferenceRunnerConfig: { runner } })

let cloudRunUrl: string | undefined
const recorder = createRecorder()
const relay = createCloudRelay(config.runId, (url) => (cloudRunUrl = url))
let resolveDone!: () => void
const done = new Promise<void>((r) => (resolveDone = r))
const coordinator = createCoordinator(() => resolveDone())

join(recorder.participant)
if (relay) join(relay.participant)
join(coordinator)
for (let i = 1; i <= config.analysts; i++) join(createAnalyst(i))
for (let i = 1; i <= config.profilers; i++) join(createProfiler(i))
join(createMatchmaker())
join(createCritic())
join(createWriter())
if (cloudRunUrl) print(`Mozaik cloud: ${cloudRunUrl} (and one live session per agent loop)`)

emit("run.requested", coordinator.getId(), {})
await done

const { proposalFiles, dir } = writeRun(state, recorder.events, recorder.loops, { cloudRunUrl, cloudLoopUrls, libraryMs })
const stats = runner.stats()
print(`\n${proposalFiles.length} proposals, ${board.interventions.length} critic interventions, ${stats.calls} model requests. Written to ${dir}/`)
await relay?.end()
await new Promise((r) => setTimeout(r, 2_500)) // let Mozaik's per-loop cloud clients flush
process.exit(0)
