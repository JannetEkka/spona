// Matchmaker: as each accepted challenge card lands, it searches the library (no model),
// scores the candidate pairs, keeps a live ranking, and queues the most promising pairs for
// evidence cards. When the critic verifies a card it re-scores that pair.
import type { Agent } from "@mozaik-ai/core"
import { emit, makeAgent, on, state } from "../runtime"
import type { Pair } from "../state"
import { finalFit, preFit } from "./fit"

export function topPairs(limit: number): Pair[] {
	return [...state().board.pairs.values()]
		.filter((p) => p.status !== "excluded" && p.status !== "rejected")
		.sort((a, b) => b.fit.total - a.fit.total)
		.slice(0, limit)
}

export function createMatchmaker(): Agent {
	let agent: Agent
	let rankingTimer: NodeJS.Timeout | undefined

	const publishRanking = () => {
		rankingTimer ??= setTimeout(() => {
			rankingTimer = undefined
			emit("ranking.updated", agent.getId(), {
				top: topPairs(8).map((p) => ({ pair: p.id, fit: p.fit.total, status: p.status })),
			})
		}, 3_000)
	}

	agent = makeAgent("matchmaker", {
		name: "Matchmaker",
		capabilities: ["search", "ranking"],
		instruction: "Ranks researcher × company pairs by fit as results land. Uses the library, not a model.",
		handlers: [
			on<{ challengeId: string }>("challenge.accepted", ({ challengeId }) => {
				const s = state()
				const card = s.board.cards.get(challengeId)!
				if (card.kind === "not_research") {
					emit("challenge.no_match", agent.getId(), { challengeId, reason: `not a research problem: ${card.why}` })
					return
				}
				const candidates = s.lib.findResearchers([...card.searchTerms, ...card.disciplines], s.config.candidatesPerChallenge)
				const pairs: Pair[] = []
				for (const c of candidates) {
					const r = s.ds.researcherById.get(c.researcherId)!
					const fit = preFit(card, c, r)
					const pair: Pair = {
						id: `${challengeId}~${c.researcherId}`,
						challengeId,
						companyId: card.companyId,
						researcherId: c.researcherId,
						candidate: c,
						fit,
						status: fit.availability === 0 ? "excluded" : "ranked",
						note: fit.availability === 0 ? fit.reasons.find((x) => x.startsWith("not proposed")) : undefined,
					}
					s.board.pairs.set(pair.id, pair)
					pairs.push(pair)
					if (pair.status === "excluded") emit("pair.excluded", agent.getId(), { pair: pair.id, reason: pair.note })
				}
				const eligible = pairs.filter((p) => p.status === "ranked").sort((a, b) => b.fit.total - a.fit.total)
				const best = eligible[0]
				if (!best || best.fit.topic < s.config.topicFloor) {
					emit("challenge.no_match", agent.getId(), {
						challengeId,
						reason: best
							? `closest work covers ${Math.round(best.fit.topic * 100)}% of the challenge's terms (${best.researcherId}); below the ${Math.round(s.config.topicFloor * 100)}% floor`
							: "no researcher's work matches the challenge's terms",
					})
				} else {
					// Queue the best pair, and the runner-up when it is nearly as close.
					for (const p of eligible.slice(0, 2)) {
						if (p !== best && (p.fit.total < best.fit.total * 0.9 || p.fit.topic < s.config.topicFloor)) continue
						p.status = "queued"
						emit("pair.queued", agent.getId(), {
							pair: p.id,
							fit: p.fit.total,
							profiler: s.board.owner.get(p.researcherId),
						})
					}
				}
				emit("pairs.ranked", agent.getId(), {
					challengeId,
					candidates: pairs.map((p) => ({ pair: p.id, fit: p.fit.total, topic: p.fit.topic, status: p.status })),
				})
				publishRanking()
			}),
			on<{ pair: string }>("card.verified", ({ pair: pairId }) => {
				const pair = state().board.pairs.get(pairId)
				if (!pair?.card) return
				const before = pair.fit.total
				pair.fit = finalFit(pair.fit, pair.card)
				const supported = pair.card.claims.filter((c) => c.status === "supported").length
				if (pair.fit.total === 0 || supported < 2) {
					pair.status = "rejected"
					pair.note =
						pair.card.verdict === "no_fit"
							? `profiler found no real fit: ${pair.card.gaps.join("; ")}`
							: `only ${supported} claim(s) survived the critic`
				} else pair.status = "verified"
				emit("pair.rescored", agent.getId(), { pair: pairId, before, after: pair.fit.total, status: pair.status, note: pair.note })
				publishRanking()
			}),
		],
	})
	return agent
}
