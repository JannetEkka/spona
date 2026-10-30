// Writes everything a reviewer needs from one run into runs/<id>/.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { source } from "../agents/evidence"
import { PRICES } from "../config"
import type { LoopRecord, TraceEvent } from "../agents/recorder"
import type { Board, SponaState } from "../state"
import { barTable, evidenceMap, pairPath, pie, withPlanGantt, type EvidenceItem } from "./visuals"

const esc = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ")
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const pct = (x: number) => `${Math.round(x * 100)}%`

function pairLabel(s: SponaState, pairId: string): string {
	const p = s.board.pairs.get(pairId)!
	const company = s.ds.companyById.get(p.companyId)!
	const r = s.ds.researcherById.get(p.researcherId)!
	return `${company.name} (${p.challengeId}) × ${r.name} (${p.researcherId})`
}

function gantt(s: SponaState, loops: LoopRecord[]): string {
	const order = ["analyst-1", "analyst-2", "analyst-3", "profiler-1", "profiler-2", "profiler-3", "critic", "writer"]
	const lines = ["```mermaid", "gantt", "    dateFormat x", "    axisFormat %M:%S", "    todayMarker off"]
	for (const agent of order) {
		const mine = loops.filter((l) => l.agent === agent && l.end !== undefined)
		if (!mine.length) continue
		lines.push(`    section ${agent}`)
		for (const l of mine) {
			const label = cut(l.task.replace(/[:;#,]/g, " ").replace(/\s+/g, " "), 38) || "loop"
			lines.push(`    ${label} : ${l.start}, ${Math.max(l.end!, l.start + 500)}`)
		}
	}
	lines.push("```")
	return lines.join("\n")
}

/** A cited publication, project or patent, with the title and year a chart can show. */
function evidenceItem(s: SponaState, id: string): EvidenceItem | undefined {
	const pub = s.ds.publications.get(id)
	if (pub) return { id, year: String(pub.year), title: pub.title }
	const prj = s.ds.projects.get(id)
	if (prj) return { id, year: prj.years, title: prj.acronym ? `${prj.acronym}: ${prj.title}` : prj.title }
	const pat = s.ds.patents.get(id)
	if (pat) return { id, year: String(pat.year), title: `Patent: ${pat.title}` }
	return undefined
}

/** Puts a chart just before the proposal's first ### section. */
function atAGlance(markdown: string, chart: string | undefined): string {
	if (!chart) return markdown
	const block = `### Why this pair, at a glance\n\n${chart}\n\n`
	const i = markdown.search(/^### /m)
	return i < 0 ? `${block}${markdown}` : markdown.slice(0, i) + block + markdown.slice(i)
}

/** What became of one challenge, in the words insights.md uses. */
export function outcomeOf(s: SponaState, challengeId: string, noMatch: Map<string, string>): string {
	const card = s.board.cards.get(challengeId)
	if (!card) return "not analysed in this run"
	if (s.board.selected.some((id) => id.startsWith(`${challengeId}~`))) return "proposal written"
	if (card.kind === "not_research") return "not a research problem"
	if (noMatch.has(challengeId)) return "no close match at the university"
	const best = [...s.board.pairs.values()].filter((p) => p.challengeId === challengeId && p.status !== "excluded").sort((a, b) => b.fit.total - a.fit.total)[0]
	if (!best) return "no close match at the university"
	if (best.status === "verified") return "a fit with checked evidence, not among the proposals"
	if (best.status === "rejected") return "the evidence didn't hold up"
	return "a close match, not profiled within this run's budget"
}

/** The board as plain JSON, so a run's report can be rebuilt without model calls (npm run report). */
export function boardToJson(board: Board) {
	return {
		...board,
		owner: [...board.owner.entries()],
		cards: [...board.cards.values()],
		pairs: [...board.pairs.values()],
		proposals: [...board.proposals.values()],
		analystsDone: [...board.analystsDone],
	}
}

export function boardFromJson(json: any): Board {
	return {
		...json,
		owner: new Map(json.owner),
		cards: new Map(json.cards.map((c: any) => [c.challengeId, c])),
		pairs: new Map(json.pairs.map((p: any) => [p.id, p])),
		proposals: new Map(json.proposals.map((p: any) => [p.pairId, p])),
		analystsDone: new Set(json.analystsDone),
	}
}

export function maxOverlap(loops: LoopRecord[]): { max: number; at: number } {
	const points = loops.flatMap((l) => (l.end === undefined ? [] : [{ t: l.start, d: 1 }, { t: l.end, d: -1 }])).sort((a, b) => a.t - b.t || a.d - b.d)
	let cur = 0
	let max = 0
	let at = 0
	for (const p of points) {
		cur += p.d
		if (cur > max) [max, at] = [cur, p.t]
	}
	return { max, at }
}

export function writeRun(s: SponaState, events: TraceEvent[], loops: Map<string, LoopRecord>, extras: { cloudRunUrl?: string; cloudLoopUrls: string[]; libraryMs: number }) {
	const dir = s.config.outDir
	mkdirSync(join(dir, "proposals"), { recursive: true })
	const { board, ds, runner } = s
	const stats = runner.stats()
	const allLoops = [...loops.values()]
	const iv0 = board.interventions
	const overlap = maxOverlap(allLoops)
	const finishedAt = events.find((e) => e.type === "run.finished")?.t ?? s.elapsed()
	// Cache writes cost 1.25× the input price and cache reads 0.1× (Anthropic's 5-minute cache).
	const cost = Object.entries(stats.byModel).reduce((sum, [m, v]) => {
		const p = PRICES[m]
		if (!p) return sum
		const plain = v.inputTokens - v.cacheWriteTokens - v.cacheReadTokens
		return sum + (plain * p.input + v.cacheWriteTokens * p.input * 1.25 + v.cacheReadTokens * p.input * 0.1 + v.outputTokens * p.output) / 1e6
	}, 0)
	const cacheNote = (v: (typeof stats.byModel)[string]) =>
		v.cacheWriteTokens || v.cacheReadTokens ? ` (of the input, ${v.cacheWriteTokens.toLocaleString()} written to and ${v.cacheReadTokens.toLocaleString()} read from the gateway's prompt cache)` : ""

	// --- proposals -------------------------------------------------------------------------
	const proposalFiles: { file: string; pairId: string; title: string }[] = []
	board.selected.forEach((pairId, i) => {
		const pair = board.pairs.get(pairId)!
		const proposal = board.proposals.get(pairId)
		if (!proposal?.markdown) return
		const claims = pair.card?.claims ?? []
		const cited = [...new Set(proposal.markdown.match(/\b(SYN-PUB-\d{5}|SYN-PRJ-\d{4}|SYN-PAT-\d{3}|R\d{4}|C\d{3}(?:-CH\d+|-P\d+)?)\b/g) ?? [])]
		const file = `${String(i + 1).padStart(2, "0")}-${pair.companyId}-${pair.researcherId}.md`
		const interventions = board.interventions.filter((x) => x.targetId.startsWith(`${pairId}@`) || x.targetId.startsWith(`${pairId}#`))
		const company = ds.companyById.get(pair.companyId)!
		const researcher = ds.researcherById.get(pair.researcherId)!
		const challengeCard = board.cards.get(pair.challengeId)
		const kept = claims.filter((c) => c.status === "supported")
		const items = [...new Set(kept.flatMap((c) => c.sources))].map((id) => evidenceItem(s, id)).filter((x): x is EvidenceItem => Boolean(x))
		const map = evidenceMap(
			{ id: pair.challengeId, company: company.name, text: company.challenges.find((c) => c.id === pair.challengeId)?.text ?? "" },
			{ id: researcher.id, name: researcher.name },
			items,
			`their work covers ${Math.round(pair.fit.topic * 100)}% of its terms`,
		)
		const rivals = [...board.pairs.values()].filter((p) => p.challengeId === pair.challengeId)
		const path = pairPath({
			challengesTotal: board.challengesTotal,
			challengeId: pair.challengeId,
			kind: challengeCard?.kind ?? "research",
			collaboration: challengeCard?.collaboration ?? "joint_project",
			researchersSearched: Object.entries(board.shards).filter(([k]) => k.startsWith("profiler-")).reduce((n, [, ids]) => n + ids.length, 0),
			candidates: rivals.length,
			aboveFloor: rivals.filter((p) => p.status !== "excluded" && p.fit.topic >= s.config.topicFloor).length,
			floorPct: Math.round(s.config.topicFloor * 100),
			researcher: `${researcher.name} (${researcher.id})`,
			topicPct: Math.round(pair.fit.topic * 100),
			fit: pair.fit.total,
			claims: claims.length,
			kept: kept.length,
			evidencePoints: interventions.filter((x) => x.stage === "evidence").length,
			proposalPoints: interventions.filter((x) => x.stage === "proposal").length,
			rounds: proposal.round + 1,
		})
		const body = [
			`> **Spona proposal ${i + 1}** · pair \`${pairId}\` · fit ${pair.fit.total} (${pair.fit.reasons.map(esc).join("; ")})`,
			`> Draft by the Proposal Writer, reviewed by the Critic in ${proposal.round + 1} round(s). A starting point for a first meeting, not a commitment by either side.`,
			"",
			withPlanGantt(atAGlance(proposal.markdown.trim(), map)),
			"",
			"---",
			"### How Spona found this pair",
			"",
			path,
			"",
			"### Evidence the critic checked",
			...claims.map((c) => `- ${c.status === "supported" ? "✅" : "❌"} ${c.text} [${c.sources.join("] [")}]${c.status !== "supported" ? ` — *${c.critic ?? c.status}*` : ""}`),
			...(interventions.length
				? ["", "### What the critic sent back", ...interventions.map((x) => `- round ${x.round}, ${x.check} check: "${esc(cut(x.claim, 160))}" — ${esc(cut(x.reason, 300))} → **${x.outcome ?? "open"}**`)]
				: []),
			...(proposal.openIssues.length ? ["", "### Critic's notes still open", ...proposal.openIssues.map((x) => `- ${x}`)] : []),
			"",
			"### Sources cited",
			...cited.map((id) => `- **${id}**: ${esc(cut(source(s, id)?.text ?? "(not in dataset)", 220))}`),
		].join("\n")
		writeFileSync(join(dir, "proposals", file), body + "\n")
		proposalFiles.push({ file, pairId, title: proposal.title })
	})

	// --- ranking ----------------------------------------------------------------------------
	const pairs = [...board.pairs.values()].sort((a, b) => b.fit.total - a.fit.total)
	const ranked = pairs.filter((p) => p.status !== "excluded")
	writeFileSync(
		join(dir, "ranking.md"),
		[
			`# Pairs ranked by fit — run ${board.runId}`,
			"",
			"Spona ranks **pairs** (one company challenge × one researcher's work), never people. Fit = topic coverage × availability + openness, then × the profiler's verdict × how much evidence survived the critic. Title, seniority, publication counts and citations are not inputs.",
			"",
			"| # | pair | status | fit | topic | avail. | open | verdict | evidence | why |",
			"|---|---|---|---|---|---|---|---|---|---|",
			...ranked.slice(0, 40).map((p, i) =>
				`| ${i + 1} | ${esc(pairLabel(s, p.id))} | ${p.status}${board.selected.includes(p.id) ? " ⭐" : ""} | ${p.fit.total} | ${p.fit.topic} | ${p.fit.availability} | ${p.fit.openness} | ${p.fit.verdict} | ${p.fit.evidence} | ${esc(cut(p.fit.reasons.join("; ") + (p.note ? ` — ${p.note}` : ""), 260))} |`,
			),
			"",
			`${ranked.length} pairs were scored in this run; the top 40 are shown. ⭐ = chosen for a proposal.`,
			"",
			"## Not proposed, and why",
			...pairs.filter((p) => p.status === "excluded").map((p) => `- ${esc(pairLabel(s, p.id))}: ${esc(p.note ?? "")}`),
			...pairs.filter((p) => p.status === "rejected").map((p) => `- ${esc(pairLabel(s, p.id))}: ${esc(p.note ?? "rejected")}`),
		].join("\n") + "\n",
	)

	// --- challenges -------------------------------------------------------------------------
	const noMatch = new Map(events.filter((e) => e.type === "challenge.no_match").map((e) => [e.data.challengeId as string, e.data.reason as string]))
	const companies = ds.companies.slice(0, s.config.companies ?? ds.companies.length)
	const kinds = { research: 0, engineering: 0, not_research: 0, missing: 0 }
	const challengeLines: string[] = []
	for (const c of companies) {
		challengeLines.push(`\n## ${c.id} ${esc(c.name)} — ${esc(c.sector)}`)
		for (const ch of c.challenges) {
			const card = board.cards.get(ch.id)
			if (!card) {
				kinds.missing++
				challengeLines.push(`- **${ch.id}** not analysed in this run`)
				continue
			}
			kinds[card.kind]++
			const best = pairs.find((p) => p.challengeId === ch.id && p.status !== "excluded")
			const outcome = board.selected.some((id) => id.startsWith(`${ch.id}~`))
				? `⭐ proposal written`
				: noMatch.has(ch.id)
					? `no proposal: ${noMatch.get(ch.id)}`
					: best
						? `best pair ${best.id} (${best.status}, fit ${best.fit.total})`
						: "no candidates"
			challengeLines.push(`- **${ch.id}** *${card.kind.replace("_", " ")}*, ${card.collaboration.replace("_", " ")}: ${esc(card.researchQuestion)} → ${esc(outcome)}`)
		}
	}
	writeFileSync(
		join(dir, "challenges.md"),
		[
			`# Every challenge and what Spona did with it — run ${board.runId}`,
			"",
			`Analysts classified ${board.cards.size} challenges: ${kinds.research} research, ${kinds.engineering} engineering with a research angle, ${kinds.not_research} not research${kinds.missing ? `, ${kinds.missing} not analysed` : ""}. A challenge that isn't research, or whose closest match is weak, gets no proposal, and the reason is given.`,
			...challengeLines,
		].join("\n") + "\n",
	)

	// --- insights -------------------------------------------------------------------------
	const outcomes = new Map<string, number>()
	const unmatchedBySector = new Map<string, number>()
	for (const c of companies)
		for (const ch of c.challenges) {
			const o = outcomeOf(s, ch.id, noMatch)
			outcomes.set(o, (outcomes.get(o) ?? 0) + 1)
			if (o === "no close match at the university") unmatchedBySector.set(c.sector, (unmatchedBySector.get(c.sector) ?? 0) + 1)
		}
	const analysed = board.cards.size
	const researchLike = kinds.research + kinds.engineering
	const unmatched = outcomes.get("no close match at the university") ?? 0
	const notResearch = [...board.cards.values()].filter((c) => c.kind === "not_research").slice(0, 2)
	const sectors = [...unmatchedBySector.entries()].sort((a, b) => b[1] - a[1])
	const ivOutcomes = new Map<string, number>()
	for (const x of iv0) ivOutcomes.set(x.outcome ?? "open", (ivOutcomes.get(x.outcome ?? "open") ?? 0) + 1)
	const order = [
		"proposal written",
		"a fit with checked evidence, not among the proposals",
		"the evidence didn't hold up",
		"a close match, not profiled within this run's budget",
		"no close match at the university",
		"not a research problem",
		"not analysed in this run",
	]
	writeFileSync(
		join(dir, "insights.md"),
		[
			`# What the run found — run ${board.runId}`,
			"",
			`Every number here is counted from this run's board; [challenges.md](challenges.md) has the line behind each one.`,
			"",
			"## What the companies asked for",
			"",
			`The three analysts classified ${analysed} of ${board.challengesTotal} challenges. ${kinds.not_research} (${pct(kinds.not_research / Math.max(1, analysed))}) are not research problems, so Spona writes no proposal for them and gives the reason${notResearch.length ? `, for example ${notResearch.map((c) => `${c.challengeId}: "${esc(cut(c.why.replace(/\.$/, ""), 140))}"`).join(" and ")}` : ""}.`,
			"",
			pie("Challenges by kind", [
				["research", kinds.research],
				["engineering with a research angle", kinds.engineering],
				["not research", kinds.not_research],
			]),
			"",
			"## What happened to each challenge",
			"",
			barTable(["outcome", "challenges"], order.filter((o) => outcomes.has(o)).map((o) => [o, outcomes.get(o)!])),
			"",
			`"A close match, not profiled" means search found a researcher whose work covers enough of the challenge's terms, but the run's evidence budget (${s.config.profileBudget} evidence cards) went to closer pairs first. A larger budget profiles more of them.`,
			"",
			"## Where the university has no close match yet",
			"",
			`${unmatched} of the ${researchLike} research and engineering challenges have no researcher whose own work covers at least ${pct(s.config.topicFloor)} of the challenge's terms. By the company's sector${sectors.length > 15 ? ` (the 15 of ${sectors.length} sectors with the most)` : ""}:`,
			"",
			barTable(["sector", "challenges with no close match"], sectors.slice(0, 15)),
			"",
			"For EINSTEIN this is a list of company needs the university can't yet meet from its own published work: input for hiring, calls and partner universities. A missing match can also mean the right person's profile doesn't use the company's words, so each one is worth a human look.",
			"",
			"## What the critic did",
			"",
			pie("Critic interventions by outcome", [...ivOutcomes.entries()]),
			"",
			barTable(
				["stage and check", "interventions"],
				(["challenge", "evidence", "proposal"] as const).flatMap((stage) =>
					(["rule", "model"] as const).map((check) => [`${stage}, ${check} check`, iv0.filter((x) => x.stage === stage && x.check === check).length] as [string, number]),
				).filter(([, v]) => v > 0),
			),
			"",
			"Rule checks cost nothing and can't be argued with: an id that doesn't exist, a paper that isn't the person's, a quote that isn't verbatim. Model checks judge whether a source says what the claim says.",
		].join("\n") + "\n",
	)

	// --- trace ------------------------------------------------------------------------------
	const iv = board.interventions
	const by = (f: (x: (typeof iv)[number]) => string) => Object.entries(iv.reduce((m: Record<string, number>, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})).map(([k, v]) => `${k}: ${v}`).join(", ")
	const domain = events.filter((e) => !["message_received.started", "model.answer", "ranking.updated", "participant.joined"].includes(e.type))
	// The worked example: the selected pair the critic sent back most often, so the review loop shows.
	const touched = (id: string) => iv.filter((x) => x.targetId.startsWith(`${id}#`) || x.targetId.startsWith(`${id}@`) || x.targetId === id.split("~")[0]).length
	const example = [...board.selected].sort((a, b) => touched(b) - touched(a))[0]
	const story = example
		? domain.filter((e) => JSON.stringify(e.data).includes(example) || JSON.stringify(e.data).includes(`"${example.split("~")[0]}"`))
		: []
	const trace = [
		`# Trace of run ${board.runId}`,
		"",
		`- **Data:** ${companies.length} companies, ${board.challengesTotal} challenges, ${ds.researchers.length} researcher records, ${ds.publications.size} publications, ${ds.projects.size} projects, ${ds.patents.size} patents, ${ds.pages.length} company pages, indexed in ${secs(extras.libraryMs)} with no model call.`,
		`- **Duration:** ${secs(finishedAt)} · **agent loops:** ${allLoops.length} · **most loops running at once:** ${overlap.max} (at ${secs(overlap.at)})`,
		`- **Model requests:** ${stats.calls} (${Object.entries(stats.byModel).map(([m, v]) => `${m}: ${v.calls} calls${v.cached ? ` + ${v.cached} cached` : ""}, ${v.inputTokens.toLocaleString()} in / ${v.outputTokens.toLocaleString()} out tokens${cacheNote(v)}`).join("; ")}). ${cost > 0 ? `Gemini on the free tier; Claude from the hackathon's gateway credit, about $${cost.toFixed(2)} at list prices.` : "Free tier only."}${stats.exhausted.length ? ` Out of daily quota during the run: ${stats.exhausted.join(", ")}.` : ""}`,
		extras.cloudRunUrl ? `- **Mozaik cloud:** run events at ${extras.cloudRunUrl}; each of the ${extras.cloudLoopUrls.length} agent loops also streamed live as its own session (first: ${extras.cloudLoopUrls[0] ?? "-"}).` : "- **Mozaik cloud:** not connected for this run.",
		`- **Critic interventions:** ${iv.length} (${by((x) => x.stage)}; ${by((x) => x.check)} checks; outcomes ${by((x) => x.outcome ?? "open")})`,
		`- **What the run found:** [insights.md](insights.md) (charts of every challenge's outcome, where the university has no close match, what the critic did)`,
		`- **Proposals:** ${proposalFiles.length}: ${proposalFiles.map((p) => `[${p.title}](proposals/${p.file})`).join(", ")}`,
		"",
		"## What ran at the same time",
		"",
		"Each bar is one Mozaik agent loop (one model question with its own context). Analysts, profilers and the critic overlap: cards are checked while other shards are still being read, and the matchmaker re-ranks as each result lands.",
		"",
		gantt(s, allLoops),
		"",
		"## Where the critic stepped in",
		"",
		"Rule checks need no model: the cited id exists, the work is really this person's (a namesake's paper is caught here), years match, quotes are verbatim. Model checks judge whether the source says what the claim says.",
		"",
		"| time | stage | item | author | check | claim | critic's reason | outcome |",
		"|---|---|---|---|---|---|---|---|",
		...iv.map((x) => `| ${secs(x.at)} | ${x.stage} | ${x.targetId} | ${x.author} | ${x.check} | ${esc(cut(x.claim, 140))} | ${esc(cut(x.reason, 220))} | ${x.outcome ?? "open"} |`),
		"",
		...(example
			? [
					`## One pair from start to finish: ${pairLabel(s, example)}`,
					"",
					"| time | agent | event | details |",
					"|---|---|---|---|",
					...story.map((e) => `| ${secs(e.t)} | ${e.by} | ${e.type} | ${esc(cut(JSON.stringify(e.data), 260))} |`),
					"",
				]
			: []),
		"## Timeline",
		"",
		"<details><summary>Every domain event on the Mozaik bus (loop events are in trace.jsonl)</summary>",
		"",
		"| time | agent | event | details |",
		"|---|---|---|---|",
		...domain.map((e) => `| ${secs(e.t)} | ${e.by} | ${e.type} | ${esc(cut(JSON.stringify(e.data), 200))} |`),
		"",
		"</details>",
	].join("\n")
	writeFileSync(join(dir, "trace.md"), trace + "\n")
	writeFileSync(join(dir, "trace.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n")
	writeFileSync(join(dir, "ledger.json"), JSON.stringify({ stats, calls: runner.ledger }, null, 1))
	writeFileSync(
		join(dir, "loops.json"),
		JSON.stringify(allLoops.map((l) => ({ ...l, ms: l.end !== undefined ? l.end - l.start : undefined })), null, 1),
	)
	writeFileSync(
		join(dir, "README.md"),
		[
			`# Run ${board.runId}`,
			"",
			`${companies.length} companies · ${board.challengesTotal} challenges · ${secs(finishedAt)} · ${stats.calls} model requests · ${iv.length} critic interventions`,
			"",
			"- [trace.md](trace.md): what ran when, and every place the critic stepped in",
			"- [insights.md](insights.md): what the run found, in charts",
			"- [ranking.md](ranking.md): pairs ranked by fit, with the reasons",
			"- [challenges.md](challenges.md): every challenge, its classification and outcome",
			...proposalFiles.map((p) => `- [proposals/${p.file}](proposals/${p.file}): ${p.title}`),
			"- trace.jsonl, loops.json, ledger.json, board.json: the raw events, loop timings, model-call ledger and the final board (`npm run report -- <run id>` rebuilds these files from them with no model call)",
		].join("\n") + "\n",
	)
	writeFileSync(join(dir, "board.json"), JSON.stringify(boardToJson(board)))
	writeFileSync(join(dir, "meta.json"), JSON.stringify({ config: s.config, ...extras }, null, 1))
	return { proposalFiles, dir }
}
