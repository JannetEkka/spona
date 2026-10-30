// The Critic runs alongside everyone else and reviews three things as they appear:
// challenge cards (analysts), evidence cards (profilers) and proposals (writer).
// Cheap rule checks come first: the id exists, the work is really this person's (not a
// namesake's), years match, quotes are verbatim. Only claims that pass the rules go to the
// model, batched, to judge whether the source really says what the claim says.
// Anything unsupported goes back to its author with the reason; after two rounds it is dropped.
import type { Agent } from "@mozaik-ai/core"
import { MODELS } from "../config"
import { fold, quoteAppearsIn } from "../data/text"
import { ask } from "../llm/ask"
import { emit, makeAgent, on, state } from "../runtime"
import type { Claim, Intervention, Pair } from "../state"
import { belongsToPair, pairPack, source } from "./evidence"

const MAX_ROUNDS = 2 // challenge and evidence cards: one revision, then unsupported claims are dropped
const PROPOSAL_ROUNDS = 3 // proposals: up to two revisions, then what is still open is printed with the proposal

const INSTRUCTION = `You are the Critic in Spona, a team of agents that proposes collaborations between University of Novi Sad researchers and NTP Novi Sad companies. You check claims against their cited sources.
For each claim, list in "not_in_source" every specific detail the claim states that the cited text does not: a method, tool, material, dataset, domain, number, year, result, or a role such as "led", "coordinated" or "developed". Paraphrase of what the source says is fine; adding to it is not. Then:
- "supported" if not_in_source is empty,
- "overstated" if the source is related but the claim adds or inflates details,
- "unsupported" if the cited source doesn't say this at all.
Never accept invented papers, skills, tools, datasets or results. Keep reasons short and concrete. Answer in JSON only.`

const VERDICT_SCHEMA = {
	type: "object",
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					claim_id: { type: "string" },
					not_in_source: { type: "array", items: { type: "string" } },
					verdict: { type: "string", enum: ["supported", "overstated", "unsupported"] },
					reason: { type: "string" },
				},
				required: ["claim_id", "not_in_source", "verdict", "reason"],
			},
		},
	},
	required: ["verdicts"],
}

const PROPOSAL_SCHEMA = {
	type: "object",
	properties: {
		problems: {
			type: "array",
			items: {
				type: "object",
				properties: {
					quote: { type: "string" },
					problem: { type: "string" },
					fix: { type: "string" },
				},
				required: ["quote", "problem", "fix"],
			},
		},
	},
	required: ["problems"],
}

const ID_PATTERN = /\b(SYN-PUB-\d{5}|SYN-PRJ-\d{4}|SYN-PAT-\d{3}|R\d{4}|C\d{3}(?:-CH\d+|-P\d+)?)\b/g

function record(i: Omit<Intervention, "at">) {
	const s = state()
	const entry = { at: s.elapsed(), ...i }
	s.board.interventions.push(entry)
	emit("critic.intervened", "critic", entry as unknown as Record<string, unknown>)
}

function settle(targetId: string, outcome: Intervention["outcome"]) {
	for (const i of state().board.interventions) if (i.targetId === targetId && !i.outcome) i.outcome = outcome
}

/** Rule checks for one claim. Returns a reason when the claim fails. */
function ruleCheck(pair: Pair, claim: Claim): string | undefined {
	const s = state()
	if (!claim.sources.length) return "cites no source"
	for (const id of claim.sources) {
		const b = belongsToPair(s, pair, id)
		if (!b.ok) return b.why
	}
	const years = claim.text.match(/\b(19[89]\d|20[0-3]\d)\b/g) ?? []
	for (const y of years.map(Number)) {
		const ok = claim.sources.some((id) => {
			const src = source(s, id)
			if (!src) return false
			if (src.year === y) return true
			if (src.years && y >= src.years[0] && y <= src.years[1]) return true
			return src.text.includes(String(y))
		})
		if (!ok) return `the year ${y} is not in ${claim.sources.join(", ")}`
	}
	return undefined
}

export function createCritic(): Agent {
	let agent: Agent
	const queue: { pair: Pair; claims: Claim[] }[] = []
	let flushTimer: NodeJS.Timeout | undefined
	let busy = 0

	function reviewChallenge(challengeId: string) {
		const s = state()
		const card = s.board.cards.get(challengeId)!
		const { challenge, company } = s.ds.challengeById.get(challengeId)!
		const haystack = `${challenge.text} ${challenge.detail} ${company.about} ${company.rd_capacity} ${company.plans}`
		let problem: string | undefined
		if (card.kind !== "not_research" && card.searchTerms.length < 4) problem = `only ${card.searchTerms.length} search terms; give 8-14`
		else if (card.quote.split(/\s+/).length > 40) problem = `the quote has ${card.quote.split(/\s+/).length} words; copy one passage of 6-25 words exactly`
		else if (!quoteAppearsIn(card.quote, haystack)) problem = `the quote "${card.quote}" does not appear in ${challengeId} or the company record; copy words exactly`
		if (problem && card.round < MAX_ROUNDS - 1) {
			card.status = "returned"
			card.criticNote = problem
			record({ stage: "challenge", targetId: challengeId, author: card.analyst, check: "rule", claim: card.quote, reason: problem, round: card.round })
			emit("challenge.returned", agent.getId(), { challengeId, reason: problem })
			return
		}
		if (problem) {
			card.quote = ""
			card.criticNote = `accepted without a quote: ${problem}`
			settle(challengeId, "left open")
		} else settle(challengeId, "revised")
		card.status = "accepted"
		emit("challenge.accepted", agent.getId(), { challengeId, kind: card.kind, collaboration: card.collaboration })
	}

	function reviewCard(pair: Pair) {
		const card = pair.card!
		const pending = card.claims.filter((c) => c.status === "pending")
		const forModel: Claim[] = []
		for (const claim of pending) {
			const why = ruleCheck(pair, claim)
			if (why) {
				claim.status = "returned"
				claim.critic = why
				record({ stage: "evidence", targetId: claim.id, author: card.profiler, check: "rule", claim: claim.text, reason: why, round: card.round })
			} else forModel.push(claim)
		}
		if (forModel.length) {
			queue.push({ pair, claims: forModel })
			flushTimer ??= setTimeout(flushModelChecks, 2_500)
		} else finishCard(pair)
	}

	async function flushModelChecks() {
		flushTimer = undefined
		const s = state()
		const batch = queue.splice(0, 6)
		if (queue.length) flushTimer = setTimeout(flushModelChecks, 2_500)
		if (!batch.length) return
		const claims = batch.flatMap((b) => b.claims)
		const sourceIds = [...new Set(claims.flatMap((c) => c.sources))]
		const prompt =
			`Check each claim against its cited sources.\n\nClaims:\n` +
			claims.map((c) => `- ${c.id}: "${c.text}" [cites ${c.sources.join(", ")}]`).join("\n") +
			`\n\nSources:\n` +
			sourceIds.map((id) => `- ${source(s, id)?.text ?? `${id}: (not found)`}`).join("\n")
		busy++
		try {
			const answer = await ask<{ verdicts: { claim_id: string; not_in_source?: string[]; verdict: string; reason: string }[] }>(agent, {
				task: `check ${claims.length} claims`,
				prompt,
				schema: VERDICT_SCHEMA,
				model: MODELS.judge,
				reasoningEffort: "low",
			})
			for (const { pair, claims: cs } of batch) {
				for (const claim of cs) {
					const v = answer.verdicts?.find((x) => x.claim_id === claim.id)
					// A "supported" verdict that still lists missing details is treated as overstated.
					if (v && v.verdict === "supported" && v.not_in_source?.length) {
						v.verdict = "overstated"
						v.reason = `not in the source: ${v.not_in_source.join("; ")}`
					}
					if (!v || v.verdict === "supported") {
						claim.status = v ? "supported" : "returned"
						if (!v) claim.critic = "the critic could not check this claim"
						settle(claim.id, "revised")
						continue
					}
					claim.status = "returned"
					claim.critic = `${v.verdict}: ${v.reason}${v.not_in_source?.length && !v.reason.includes(v.not_in_source[0]) ? ` (not in the source: ${v.not_in_source.join("; ")})` : ""}`
					record({ stage: "evidence", targetId: claim.id, author: pair.card!.profiler, check: "model", claim: claim.text, reason: claim.critic, round: pair.card!.round })
				}
			}
		} catch (e) {
			// If the model can't check, the claims don't pass: nothing unchecked reaches a proposal.
			for (const { claims: cs } of batch) for (const c of cs) Object.assign(c, { status: "returned", critic: `not checked: ${(e as Error).message}` })
			emit("agent.error", agent.getId(), { while: "check claims", error: String((e as Error).message) })
		} finally {
			busy--
		}
		for (const { pair } of batch) finishCard(pair)
	}

	function finishCard(pair: Pair) {
		const card = pair.card!
		if (card.claims.some((c) => c.status === "pending")) return
		const returned = card.claims.filter((c) => c.status === "returned")
		if (returned.length && card.round < MAX_ROUNDS - 1) {
			emit("card.returned", agent.getId(), { pair: pair.id, claims: returned.map((c) => ({ id: c.id, reason: c.critic })) })
			return
		}
		for (const c of returned) {
			c.status = "dropped"
			settle(c.id, "dropped")
		}
		for (const c of card.claims) if (c.status === "dropped") settle(c.id, c.critic?.includes("withdrawn") ? "withdrawn" : "dropped")
		emit("card.verified", agent.getId(), {
			pair: pair.id,
			supported: card.claims.filter((c) => c.status === "supported").length,
			dropped: card.claims.filter((c) => c.status === "dropped").length,
		})
	}

	async function reviewProposal(pairId: string) {
		const s = state()
		const pair = s.board.pairs.get(pairId)!
		const proposal = s.board.proposals.get(pairId)!
		const problems: { quote: string; problem: string; check: "rule" | "model" }[] = []

		const cited = [...new Set(proposal.markdown.match(ID_PATTERN) ?? [])]
		for (const id of cited) {
			const b = belongsToPair(s, pair, id)
			if (!b.ok) problems.push({ quote: id, problem: b.why!, check: "rule" })
		}
		const researcher = s.ds.researcherById.get(pair.researcherId)!
		const company = s.ds.companyById.get(pair.companyId)!
		const draft = fold(proposal.markdown)
		if (!draft.includes(fold(researcher.name))) problems.push({ quote: "(whole proposal)", problem: `does not name the researcher ${researcher.name}`, check: "rule" })
		if (!draft.includes(fold(company.name).replace(/ d\.o\.o\.| a\.d\./, ""))) problems.push({ quote: "(whole proposal)", problem: `does not name the company ${company.name}`, check: "rule" })
		// People named in the draft must be named in the sources, spelled the same way.
		const known = fold(
			[pairPack(s, pair), source(s, pair.companyId)!.text, ...(s.ds.pagesByCompany.get(pair.companyId) ?? []).map((p) => p.text), ...company.challenges.map((c) => c.detail)].join(" "),
		)
		const named = proposal.markdown.match(/(?:Prof(?:essor)?\.?|Dr\.?)\s+[A-ZČĆŠŽĐ\u0400-\u04FF][\p{L}'’-]+(?:\s+[A-ZČĆŠŽĐ\u0400-\u04FF][\p{L}'’-]+)?|(?<![\p{L}])[A-ZČĆŠŽĐ][\p{L}'’-]+\s+[A-ZČĆŠŽĐ][\p{L}'’-]*[čćšžđáéíóöőúüűāēī][\p{L}'’-]*(?![\p{L}])/gu) ?? []
		for (const raw of new Set(named)) {
			// "Prof. Kiss's group" names Kiss: stop at the first possessive and drop the 's.
			const words = raw.replace(/^(?:Prof(?:essor)?\.?|Dr\.?)\s+/, "").split(/\s+/)
			const cut = words.findIndex((w) => /['’]s$/.test(w))
			const name = (cut >= 0 ? words.slice(0, cut + 1) : words).join(" ").replace(/['’]s$/, "")
			if (!known.includes(fold(name))) problems.push({ quote: raw, problem: `"${name}" is not named, or not spelled this way, in any source for this pair`, check: "rule" })
		}

		// Points from the previous round: fixed if the quoted words are gone from this draft.
		for (const i of s.board.interventions)
			if (i.stage === "proposal" && i.targetId.startsWith(`${pairId}@`) && !i.outcome)
				i.outcome = i.claim.startsWith("(") || quoteAppearsIn(i.claim, proposal.markdown) ? "kept after revision" : "revised"

		const valid = cited.filter((id) => belongsToPair(s, pair, id).ok)
		busy++
		try {
			const answer = await ask<{ problems: { quote: string; problem: string; fix: string }[] }>(agent, {
				task: `review proposal ${pairId} round ${proposal.round}`,
				prompt:
					`Review this draft proposal. List every statement of fact about the researcher, the company or their past work that the sources below don't support: invented papers, skills, tools, staff, data volumes, equipment, customers, numbers or dates. Plans, research questions and proposed work are not facts and are fine. Quote the exact words. If everything is supported, return an empty list.\n\n` +
					`## Draft\n${proposal.markdown}\n\n## Sources\n${pairPack(s, pair)}\n` +
					valid.map((id) => `- ${source(s, id)!.text}`).join("\n"),
				schema: PROPOSAL_SCHEMA,
				model: MODELS.judge,
				reasoningEffort: "low",
			})
			for (const p of answer.problems ?? []) problems.push({ quote: p.quote, problem: `${p.problem} Fix: ${p.fix}`, check: "model" })
		} catch (e) {
			problems.push({ quote: "(whole proposal)", problem: `could not be checked: ${(e as Error).message}`, check: "model" })
		} finally {
			busy--
		}

		for (const p of problems)
			record({ stage: "proposal", targetId: `${pairId}@${proposal.round}`, author: "writer", check: p.check, claim: p.quote, reason: p.problem, round: proposal.round })
		if (problems.length && proposal.round < PROPOSAL_ROUNDS - 1) {
			proposal.status = "returned"
			emit("proposal.returned", agent.getId(), { pair: pairId, problems })
			return
		}
		for (const i of s.board.interventions) if (i.stage === "proposal" && i.targetId.startsWith(`${pairId}@`) && !i.outcome) i.outcome = "left open"
		proposal.openIssues = problems.map((p) => `"${p.quote}": ${p.problem}`)
		proposal.status = "accepted"
		emit("proposal.accepted", agent.getId(), { pair: pairId, round: proposal.round, openIssues: proposal.openIssues.length })
	}

	agent = makeAgent("critic", {
		name: "Critic",
		capabilities: ["inference", "verification"],
		instruction: INSTRUCTION,
		handlers: [
			on<{ challengeId: string }>("challenge.submitted", ({ challengeId }) => reviewChallenge(challengeId)),
			on<{ pair: string }>("card.submitted", ({ pair }) => {
				const p = state().board.pairs.get(pair)
				if (p?.card) reviewCard(p)
			}),
			on<{ pair: string }>("proposal.submitted", ({ pair }) => reviewProposal(pair)),
		],
	})
	;(agent as any).isBusy = () => busy > 0 || queue.length > 0 || flushTimer !== undefined
	return agent
}
