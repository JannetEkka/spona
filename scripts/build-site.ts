// Builds the data for the GitHub Pages site (docs/index.html) from a recorded run: every number,
// loop, critic intervention and proposal on the page comes from runs/<id>/. No model calls.
// Run: npm run site -- <run id>   (writes docs/data/run.js)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import type { LoopRecord, TraceEvent } from "../src/agents/recorder"
import { PRICES } from "../src/config"
import { loadDataset } from "../src/data/load"
import { Library } from "../src/data/search"
import type { SponaRunner } from "../src/llm/runner"
import { SponaState } from "../src/state"
import { boardFromJson, maxOverlap, outcomeOf } from "../src/trace/report"

const runId = process.argv[2] ?? "2026-10-31-full"
const dir = `runs/${runId}`
if (!existsSync(`${dir}/board.json`)) {
	console.error(`${dir}/board.json is needed: record the run with the current code, or pass another run id.`)
	process.exit(1)
}
const read = (f: string) => readFileSync(`${dir}/${f}`, "utf-8")
const meta = JSON.parse(read("meta.json"))
const ledger = JSON.parse(read("ledger.json"))
const board = boardFromJson(JSON.parse(read("board.json")))
const events: TraceEvent[] = read("trace.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const loops: (LoopRecord & { ms?: number })[] = JSON.parse(read("loops.json"))
const ds = loadDataset()
const s = new SponaState(meta.config, ds, new Library(ds), { stats: () => ledger.stats, ledger: ledger.calls } as unknown as SponaRunner, board)

const finishedAt = events.find((e) => e.type === "run.finished")?.t ?? Math.max(...loops.map((l) => l.end ?? 0))
const overlap = maxOverlap(loops)
const byModel = ledger.stats.byModel as Record<string, { calls: number; inputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number; outputTokens: number }>
const cost = Object.entries(byModel).reduce((sum, [m, v]) => {
	const p = PRICES[m]
	if (!p) return sum
	const write = v.cacheWriteTokens ?? 0
	const readTokens = v.cacheReadTokens ?? 0
	return sum + ((v.inputTokens - write - readTokens) * p.input + write * p.input * 1.25 + readTokens * p.input * 0.1 + v.outputTokens * p.output) / 1e6
}, 0)

// What became of each challenge, and where the university has no close match.
const noMatch = new Map(events.filter((e) => e.type === "challenge.no_match").map((e) => [e.data.challengeId as string, e.data.reason as string]))
const outcomes: Record<string, number> = {}
const gaps: Record<string, number> = {}
const kinds = { research: 0, engineering: 0, not_research: 0 }
for (const c of ds.companies)
	for (const ch of c.challenges) {
		const o = outcomeOf(s, ch.id, noMatch)
		outcomes[o] = (outcomes[o] ?? 0) + 1
		if (o === "no close match at the university") gaps[c.sector] = (gaps[c.sector] ?? 0) + 1
		const card = board.cards.get(ch.id)
		if (card) kinds[card.kind]++
	}

// The events the replay's ticker shows: the ones a person would want to see happen.
const label = (id: string) => {
	const [challengeId, researcherId] = id.split("~")
	const company = ds.companyById.get(challengeId.split("-")[0])?.name ?? challengeId
	const researcher = researcherId ? ds.researcherById.get(researcherId)?.name : undefined
	return researcher ? `${company} × ${researcher}` : company
}
const ticker: { t: number; by: string; text: string }[] = []
for (const e of events) {
	const d = e.data as any
	if (e.type === "critic.intervened") ticker.push({ t: e.t, by: "critic", text: `sent back a ${d.stage} ${d.stage === "challenge" ? "card" : d.stage === "evidence" ? "claim" : "statement"} to ${d.author}: ${String(d.reason).slice(0, 140)}` })
	else if (e.type === "card.verified") ticker.push({ t: e.t, by: "critic", text: `checked the evidence for ${label(d.pair)}: ${d.supported} claims kept, ${d.dropped} dropped` })
	else if (e.type === "analyst.done") ticker.push({ t: e.t, by: e.by, text: "finished its companies" })
	else if (e.type === "selection.made") ticker.push({ t: e.t, by: "coordinator", text: `chose ${(d.pairs ?? board.selected).length} pairs for proposals` })
	else if (e.type === "proposal.submitted") ticker.push({ t: e.t, by: "writer", text: `${d.round ? `revised (round ${d.round})` : "drafted"} the proposal for ${label(d.pair)}` })
	else if (e.type === "proposal.accepted") ticker.push({ t: e.t, by: "critic", text: `accepted the proposal for ${label(d.pair)}${d.openIssues ? ` with ${d.openIssues} point(s) printed as open` : ""}` })
	else if (e.type === "run.finished") ticker.push({ t: e.t, by: "coordinator", text: "run finished" })
}

const proposalDir = `${dir}/proposals`
const files = readdirSync(proposalDir).filter((f) => f.endsWith(".md")).sort()
const proposals = board.selected
	.map((pairId, i) => {
		const pair = board.pairs.get(pairId)!
		const file = files.find((f) => f.startsWith(String(i + 1).padStart(2, "0")))
		if (!file) return undefined
		return {
			file,
			pairId,
			title: board.proposals.get(pairId)?.title ?? pairId,
			company: ds.companyById.get(pair.companyId)!.name,
			researcher: ds.researcherById.get(pair.researcherId)!.name,
			markdown: readFileSync(`${proposalDir}/${file}`, "utf-8"),
		}
	})
	.filter(Boolean)

const iv = board.interventions
const data = {
	runId,
	repo: "https://github.com/JannetEkka/spona",
	cloudRunUrl: meta.cloudRunUrl,
	stats: {
		durationMs: finishedAt,
		loops: loops.length,
		maxOverlap: overlap.max,
		maxOverlapAt: overlap.at,
		requests: ledger.stats.calls,
		byModel: Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, { calls: v.calls, inputTokens: v.inputTokens, outputTokens: v.outputTokens }])),
		costUsd: Math.round(cost * 100) / 100,
		companies: ds.companies.length,
		challenges: board.challengesTotal,
		researchers: ds.researchers.length,
		publications: ds.publications.size,
		interventions: iv.length,
		sentBack: iv.filter((x) => x.stage !== "challenge" && (x.outcome === "revised" || x.outcome === "dropped" || x.outcome === "withdrawn")).length,
		evidenceClaims: [...board.pairs.values()].reduce((n, p) => n + (p.card?.claims.length ?? 0), 0),
		evidenceCards: [...board.pairs.values()].filter((p) => p.card).length,
	},
	kinds,
	outcomes,
	gaps: Object.entries(gaps).sort((a, b) => b[1] - a[1]),
	loops: loops
		.filter((l) => l.end !== undefined)
		.map((l) => ({ agent: l.agent, task: l.task, start: l.start, end: l.end!, model: l.model, tokens: (l as any).tokens ?? 0 }))
		.sort((a, b) => a.start - b.start),
	ticker,
	interventions: iv.map((x) => ({ at: x.at, stage: x.stage, target: x.targetId, author: x.author, check: x.check, claim: x.claim, reason: x.reason, outcome: x.outcome ?? "open" })),
	proposals,
}

mkdirSync("docs/data", { recursive: true })
writeFileSync("docs/data/run.js", `// Generated by scripts/build-site.ts from runs/${runId}/. Do not edit by hand.\nwindow.SPONA = ${JSON.stringify(data)};\n`)
console.log(`wrote docs/data/run.js from ${dir}: ${data.loops.length} loops, ${data.ticker.length} ticker events, ${data.interventions.length} interventions, ${data.proposals.length} proposals`)
