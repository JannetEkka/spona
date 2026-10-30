// Research Profilers: each owns a shard of researchers (by faculty). When the matchmaker queues
// a pair whose researcher is in its shard, the profiler writes an evidence card: what this
// person has done that bears on this challenge, each claim citing its source. Cards go to the
// critic; returned claims come back here to be fixed or withdrawn.
import type { Agent } from "@mozaik-ai/core"
import { MODELS } from "../config"
import { ask } from "../llm/ask"
import { emit, makeAgent, on, state } from "../runtime"
import type { Claim, EvidenceCard, Pair } from "../state"
import { pairPack } from "./evidence"

const INSTRUCTION = `You are a Research Profiler in Spona, a team of agents that proposes collaborations between University of Novi Sad researchers and NTP Novi Sad companies.
For each pair you get a company challenge and one researcher's profile with their matching work. Write an evidence card:
- verdict: "strong" (their own work addresses the core of the challenge), "plausible" (relevant methods or domain, a real gap remains), "weak" (only surface overlap) or "no_fit". Judge the pair, not the person: never comment on how good or senior someone is.
- joint_problem: two sentences on what the company and this researcher could work out together, in plain language.
- claims: 3-5 short factual statements about what this researcher has done that bears on the challenge. Each cites 1-3 ids from the evidence given (SYN-PUB-…, SYN-PRJ-…, SYN-PAT-…, or the researcher id for profile statements). Only state what the cited text says. Never add tools, datasets, results, numbers or skills the source doesn't mention. Never cite an id that isn't in the evidence.
- gaps: what is missing for this pair to work (skills, data, availability). Say "none" only if nothing is.
Answer in JSON only.`

const CARD_SCHEMA = {
	type: "object",
	properties: {
		cards: {
			type: "array",
			items: {
				type: "object",
				properties: {
					pair_id: { type: "string" },
					verdict: { type: "string", enum: ["strong", "plausible", "weak", "no_fit"] },
					joint_problem: { type: "string" },
					claims: {
						type: "array",
						items: {
							type: "object",
							properties: { text: { type: "string" }, sources: { type: "array", items: { type: "string" } } },
							required: ["text", "sources"],
						},
					},
					gaps: { type: "array", items: { type: "string" } },
				},
				required: ["pair_id", "verdict", "joint_problem", "claims", "gaps"],
			},
		},
	},
	required: ["cards"],
}

const REVISION_SCHEMA = {
	type: "object",
	properties: {
		claims: {
			type: "array",
			items: {
				type: "object",
				properties: {
					claim_id: { type: "string" },
					action: { type: "string", enum: ["revise", "withdraw"] },
					text: { type: "string" },
					sources: { type: "array", items: { type: "string" } },
				},
				required: ["claim_id", "action", "text", "sources"],
			},
		},
	},
	required: ["claims"],
}

interface CardAnswer {
	cards: { pair_id: string; verdict: EvidenceCard["verdict"]; joint_problem: string; claims: { text: string; sources: string[] }[]; gaps: string[] }[]
}
interface RevisionAnswer {
	claims: { claim_id: string; action: "revise" | "withdraw"; text: string; sources: string[] }[]
}

export function createProfiler(n: number): Agent {
	let agent: Agent
	let pullTimer: NodeJS.Timeout | undefined
	let inFlight = 0

	const schedulePull = () => {
		pullTimer ??= setTimeout(() => {
			pullTimer = undefined
			void pull()
		}, 4_000)
	}

	/** Budget opens up as analysis progresses, so early results can't use up every evidence card. */
	function unlockedBudget(): number {
		const s = state()
		const b = s.board
		const analysed = [...b.cards.values()].filter((c) => c.status === "accepted").length
		const share = b.challengesTotal ? analysed / b.challengesTotal : 1
		if (b.analystsDone.size >= s.config.analysts) return b.profileBudget
		return Math.min(b.profileBudget, Math.ceil(b.profileBudget * share) + 3)
	}

	async function pull() {
		const s = state()
		if (inFlight >= 2) return
		// The budget goes to the best pairs on the whole board, not to whichever profiler asks first:
		// a queued pair is eligible only if it ranks inside the unlocked budget among every pair
		// that is queued or already has (or is getting) an evidence card.
		const all = [...s.board.pairs.values()]
		const contenders = all.filter((p) => p.status === "queued" || p.card || p.status === "profiling").sort((a, b) => b.fit.total - a.fit.total)
		const budget = unlockedBudget()
		const eligible = new Set(contenders.slice(0, budget).map((p) => p.id))
		const mine = all
			.filter((p) => p.status === "queued" && s.board.owner.get(p.researcherId) === agent.getId())
			.sort((a, b) => b.fit.total - a.fit.total)
		const room = budget - s.board.profilesStarted
		const take = mine.filter((p) => eligible.has(p.id)).slice(0, Math.min(s.config.profilerBatch, room))
		if (!take.length) return
		for (const p of take) p.status = "profiling"
		s.board.profilesStarted += take.length
		inFlight++
		try {
			await profile(take)
		} finally {
			inFlight--
			if (mine.length > take.length) schedulePull()
		}
	}

	async function profile(pairs: Pair[]) {
		const s = state()
		const task = `evidence ${pairs.map((p) => p.id).join(",")}`
		try {
			const answer = await ask<CardAnswer>(agent, {
				task,
				prompt: `Write one evidence card per pair.\n\n${pairs.map((p) => pairPack(s, p)).join("\n\n")}`,
				schema: CARD_SCHEMA,
				model: MODELS.fast,
			})
			for (const pair of pairs) {
				const a = answer.cards?.find((c) => c.pair_id === pair.id)
				if (!a) {
					pair.status = "rejected"
					pair.note = "profiler returned no card"
					emit("card.missing", agent.getId(), { pair: pair.id })
					continue
				}
				const claims: Claim[] = (a.claims ?? []).slice(0, 5).map((c, i) => ({
					id: `${pair.id}#${i + 1}`,
					text: c.text,
					sources: (c.sources ?? []).map((x) => x.trim()),
					status: "pending",
				}))
				pair.card = { pairId: pair.id, verdict: a.verdict, jointProblem: a.joint_problem, claims, gaps: a.gaps ?? [], round: 0, profiler: agent.getId() }
				pair.status = "reviewing"
				emit("card.submitted", agent.getId(), { pair: pair.id, verdict: a.verdict, claims: claims.length, round: 0 })
			}
		} catch (e) {
			for (const pair of pairs) {
				pair.status = "rejected"
				pair.note = `profiling failed: ${(e as Error).message}`
			}
			emit("agent.error", agent.getId(), { while: task, error: String((e as Error).message) })
		}
	}

	// Returned cards are collected for a moment and revised together: one call, not one per card.
	const toRevise: Pair[] = []
	let reviseTimer: NodeJS.Timeout | undefined

	async function revise(pairs: Pair[]) {
		const s = state()
		const returned = pairs.flatMap((p) => p.card!.claims.filter((c) => c.status === "returned"))
		const task = `revise evidence ${pairs.map((p) => p.id).join(",")}`
		try {
			const answer = await ask<RevisionAnswer>(agent, {
				task,
				prompt:
					`The critic returned these claims from your evidence cards. For each, either revise it so the cited source really supports it, or withdraw it.\n` +
					returned.map((c) => `- ${c.id}: "${c.text}" citing ${c.sources.join(", ")}. Critic: ${c.critic}`).join("\n") +
					`\n\n${pairs.map((p) => pairPack(s, p)).join("\n\n")}`,
				schema: REVISION_SCHEMA,
				model: MODELS.fast,
			})
			for (const c of returned) {
				const a = answer.claims?.find((x) => x.claim_id === c.id)
				if (!a || a.action === "withdraw") {
					c.status = "dropped"
					c.critic = `${c.critic} (withdrawn by profiler)`
					continue
				}
				c.text = a.text
				c.sources = a.sources.map((x) => x.trim())
				c.status = "pending"
			}
		} catch (e) {
			for (const c of returned) c.status = "dropped"
			emit("agent.error", agent.getId(), { while: task, error: String((e as Error).message) })
		}
		for (const pair of pairs) {
			const card = pair.card!
			card.round++
			emit("card.submitted", agent.getId(), { pair: pair.id, verdict: card.verdict, claims: card.claims.length, round: card.round })
		}
	}

	agent = makeAgent(`profiler-${n}`, {
		name: `Research Profiler ${n}`,
		capabilities: ["inference", "researcher-profiles"],
		instruction: INSTRUCTION,
		handlers: [
			on<{ profiler?: string }>("pair.queued", ({ profiler }) => {
				if (profiler === agent.getId()) schedulePull()
			}),
			on(["challenge.accepted", "analyst.done"], () => schedulePull()),
			on<{ pair: string }>("card.returned", ({ pair: pairId }) => {
				const pair = state().board.pairs.get(pairId)
				if (pair?.card?.profiler !== agent.getId()) return
				toRevise.push(pair)
				reviseTimer ??= setTimeout(() => {
					reviseTimer = undefined
					void revise(toRevise.splice(0))
				}, 3_000)
			}),
		],
	})
	return agent
}
