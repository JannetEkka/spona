// Writes everything a reviewer needs from one run into runs/<id>/.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { source } from "../agents/evidence"
import type { LoopRecord, TraceEvent } from "../agents/recorder"
import type { SponaState } from "../state"

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

function maxOverlap(loops: LoopRecord[]): { max: number; at: number } {
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
	const overlap = maxOverlap(allLoops)
	const finishedAt = events.find((e) => e.type === "run.finished")?.t ?? s.elapsed()

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
		const body = [
			`> **Spona proposal ${i + 1}** · pair \`${pairId}\` · fit ${pair.fit.total} (${pair.fit.reasons.map(esc).join("; ")})`,
			`> Draft by the Proposal Writer, reviewed by the Critic in ${proposal.round + 1} round(s). A starting point for a first meeting, not a commitment by either side.`,
			"",
			proposal.markdown.trim(),
			"",
			"---",
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
		`- **Model requests:** ${stats.calls} (${Object.entries(stats.byModel).map(([m, v]) => `${m}: ${v.calls} calls${v.cached ? ` + ${v.cached} cached` : ""}, ${v.inputTokens.toLocaleString()} in / ${v.outputTokens.toLocaleString()} out tokens`).join("; ")}). Free tier only.${stats.exhausted.length ? ` Out of daily quota during the run: ${stats.exhausted.join(", ")}.` : ""}`,
		extras.cloudRunUrl ? `- **Mozaik cloud:** run events at ${extras.cloudRunUrl}; each of the ${extras.cloudLoopUrls.length} agent loops also streamed live as its own session (first: ${extras.cloudLoopUrls[0] ?? "-"}).` : "- **Mozaik cloud:** not connected for this run.",
		`- **Critic interventions:** ${iv.length} (${by((x) => x.stage)}; ${by((x) => x.check)} checks; outcomes ${by((x) => x.outcome ?? "open")})`,
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
			"- [ranking.md](ranking.md): pairs ranked by fit, with the reasons",
			"- [challenges.md](challenges.md): every challenge, its classification and outcome",
			...proposalFiles.map((p) => `- [proposals/${p.file}](proposals/${p.file}): ${p.title}`),
			"- trace.jsonl, loops.json, ledger.json: the raw events, loop timings and model-call ledger",
		].join("\n") + "\n",
	)
	return { proposalFiles, dir }
}
