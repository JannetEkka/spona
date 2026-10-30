// Coordinator: splits the data into shards, watches progress on the shared board, and decides
// when the ranking is settled enough to choose pairs for proposals. It never calls a model.
import type { Agent } from "@mozaik-ai/core"
import { createInterface } from "node:readline/promises"
import { canonicalFaculty } from "../data/people"
import { emit, makeAgent, on, resolveRuntime, state } from "../runtime"
import type { Pair } from "../state"

export function createCoordinator(onFinished: () => void): Agent {
	let agent: Agent
	let selecting = false
	let finished = false
	let watchdog: NodeJS.Timeout | undefined

	function start() {
		const s = state()
		const { config, board, ds, lib } = s
		const companies = ds.companies.slice(0, config.companies ?? ds.companies.length)
		board.challengesTotal = companies.reduce((n, c) => n + c.challenges.length, 0)

		// Companies: round-robin, so every analyst sees a mix of sectors.
		for (let i = 0; i < config.analysts; i++) board.shards[`analyst-${i + 1}`] = []
		companies.forEach((c, i) => board.shards[`analyst-${(i % config.analysts) + 1}`].push(c.id))

		// Researchers: whole faculties per profiler, balanced by head count.
		const byFaculty = new Map<string, string[]>()
		for (const r of ds.researchers) {
			if (lib.mainRecord(r.id) !== r.id) continue
			const f = canonicalFaculty(r.faculty)
			byFaculty.set(f, [...(byFaculty.get(f) ?? []), r.id])
		}
		const profilers = Array.from({ length: config.profilers }, (_, i) => ({ id: `profiler-${i + 1}`, ids: [] as string[], faculties: [] as string[] }))
		for (const [faculty, ids] of [...byFaculty.entries()].sort((a, b) => b[1].length - a[1].length)) {
			const target = profilers.reduce((a, b) => (a.ids.length <= b.ids.length ? a : b))
			target.ids.push(...ids)
			target.faculties.push(faculty)
		}
		for (const p of profilers) {
			board.shards[p.id] = p.ids
			for (const id of p.ids) for (const rid of lib.people.sameAs.get(id) ?? []) board.owner.set(rid, p.id)
			for (const id of p.ids) board.owner.set(id, p.id)
		}

		emit("run.started", agent.getId(), {
			runId: board.runId,
			companies: companies.length,
			challenges: board.challengesTotal,
			researchers: byFaculty.size ? [...byFaculty.values()].reduce((n, l) => n + l.length, 0) : 0,
			publications: ds.publications.size,
			profileBudget: board.profileBudget,
			proposals: config.proposals,
		})
		for (let i = 1; i <= config.analysts; i++) {
			const id = `analyst-${i}`
			emit("shard.assigned", agent.getId(), { agentId: id, kind: "companies", companyIds: board.shards[id] })
		}
		for (const p of profilers) emit("shard.assigned", agent.getId(), { agentId: p.id, kind: "researchers", count: p.ids.length, faculties: p.faculties })

		watchdog = setInterval(check, 5_000)
	}

	function settled(): boolean {
		const { board, config } = state()
		const critic = resolveRuntime().state.getParticipant("critic") as any
		if (board.analystsDone.size < config.analysts) return false
		const cards = [...board.cards.values()]
		if (cards.some((c) => c.status !== "accepted")) return false
		const pairs = [...board.pairs.values()]
		if (pairs.some((p) => p.status === "profiling" || p.status === "reviewing")) return false
		const queued = pairs.some((p) => p.status === "queued")
		if (queued && board.profilesStarted < board.profileBudget) return false
		return !critic?.isBusy?.()
	}

	function check() {
		const s = state()
		if (selecting || finished) return
		const late = s.elapsed() > s.config.maxMinutes * 60_000
		if (settled() || late) void select(late)
	}

	async function select(late: boolean) {
		selecting = true
		const s = state()
		// Research challenges come before engineering ones with a research angle: the brief asks for
		// industrial PhD topics and joint projects. This weighs the challenge, not the person.
		const weight = (p: Pair) => p.fit.total * (s.board.cards.get(p.challengeId)?.kind === "research" ? 1 : 0.85)
		const verified = [...s.board.pairs.values()].filter((p) => p.status === "verified").sort((a, b) => weight(b) - weight(a))
		const chosen: Pair[] = []
		const companies = new Set<string>()
		const people = new Set<string>()
		for (const p of verified) {
			if (chosen.length >= s.config.proposals) break
			if (companies.has(p.companyId) || people.has(p.researcherId)) continue
			chosen.push(p)
			companies.add(p.companyId)
			people.add(p.researcherId)
		}
		for (const p of s.board.pairs.values()) if (p.status === "queued") p.note = "not profiled: evidence-card budget used up by closer pairs"

		if (s.config.approve) {
			console.log("\nShortlist for proposals:")
			for (const p of chosen) console.log(`  ${p.id}  fit ${p.fit.total}  ${p.fit.reasons.join(" | ")}`)
			const rl = createInterface({ input: process.stdin, output: process.stdout })
			const answer = await rl.question("Write proposals for these pairs? [Y/n] ")
			rl.close()
			emit("human.decided", agent.getId(), { approved: !/^n/i.test(answer.trim()), pairs: chosen.map((p) => p.id) })
			if (/^n/i.test(answer.trim())) return finish()
		}

		s.board.selected = chosen.map((p) => p.id)
		emit("selection.made", agent.getId(), {
			pairs: s.board.selected,
			late,
			considered: verified.length,
			rule: "highest fit first (engineering challenges weighted 0.85 against research ones); at most one proposal per company and per researcher",
		})
		if (!chosen.length) finish()
	}

	function finish() {
		if (finished) return
		finished = true
		if (watchdog) clearInterval(watchdog)
		state().board.finished = true
		emit("run.finished", agent.getId(), { elapsedMs: state().elapsed(), calls: state().runner.stats() })
		onFinished()
	}

	agent = makeAgent("coordinator", {
		name: "Coordinator",
		capabilities: ["planning", "progress"],
		instruction: "Splits the data into shards, tracks progress on the shared board and decides when to select pairs. Uses no model.",
		handlers: [
			on("run.requested", () => start()),
			on("analyst.done", (_p, event) => {
				state().board.analystsDone.add(event.producerId)
				check()
			}),
			on(["challenge.accepted", "challenge.missing", "card.verified", "card.missing", "pair.rescored", "agent.error"], () => check()),
			on("proposal.accepted", () => {
				const s = state()
				if (s.board.selected.every((id) => s.board.proposals.get(id)?.status === "accepted")) finish()
			}),
		],
	})
	return agent
}
