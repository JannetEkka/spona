// Industry Analysts: each owns a shard of companies and turns their business-language challenges
// into research terms the library can search. Cards go to the critic before anyone uses them.
import type { Agent } from "@mozaik-ai/core"
import { MODELS } from "../config"
import type { Company } from "../data/load"
import { truncate } from "../data/text"
import { ask } from "../llm/ask"
import { emit, makeAgent, on, state } from "../runtime"
import type { ChallengeCard, ChallengeKind, Collaboration } from "../state"

const INSTRUCTION = `You are an Industry Analyst in Spona, a team of agents that finds University of Novi Sad researcher × NTP Novi Sad company pairs for joint projects and industrial PhDs.
You read company records (some in Serbian, Latin or Cyrillic) and translate each challenge from business language into the language researchers use.
For every challenge:
- kind: "research" if answering it needs new knowledge or methods; "engineering" if it is mostly building or integrating known technology but a research angle exists; "not_research" if it is hiring, sales, funding, buying a product, compliance paperwork or similar. Be honest: many challenges are not research.
- why: one sentence on that judgement.
- research_question: the challenge restated as one research question in academic English.
- disciplines: 2-4 academic fields.
- search_terms: 8-14 short phrases researchers would put in paper titles or keywords (academic English), plus 2-3 Serbian Latin equivalents of the key terms.
- collaboration: "industrial_phd" for a multi-year research problem the company could host, "joint_project" for a 1-2 year applied project, "contract_research" for a short well-defined study, "none" for not_research.
- quote: one passage of 6-25 consecutive words copied exactly from the company's own text, in the language it is written in, that shows the problem. Copy, don't paraphrase or translate: it is checked word by word.
Never mention or guess people. Answer in JSON only.`

const SCHEMA = {
	type: "object",
	properties: {
		challenges: {
			type: "array",
			items: {
				type: "object",
				properties: {
					challenge_id: { type: "string" },
					kind: { type: "string", enum: ["research", "engineering", "not_research"] },
					why: { type: "string" },
					research_question: { type: "string" },
					disciplines: { type: "array", items: { type: "string" } },
					search_terms: { type: "array", items: { type: "string" } },
					collaboration: { type: "string", enum: ["industrial_phd", "joint_project", "contract_research", "none"] },
					quote: { type: "string" },
				},
				required: ["challenge_id", "kind", "why", "research_question", "disciplines", "search_terms", "collaboration", "quote"],
			},
		},
	},
	required: ["challenges"],
}

interface AnalystAnswer {
	challenges: {
		challenge_id: string
		kind: ChallengeKind
		why: string
		research_question: string
		disciplines: string[]
		search_terms: string[]
		collaboration: Collaboration
		quote: string
	}[]
}

function describeCompany(c: Company): string {
	return [
		`## ${c.id} ${c.name} (${c.sector}; ${c.employees} people; ${c.location}; record language: ${c.language})`,
		`About: ${truncate(c.about, 900)}`,
		`Products: ${c.products.join("; ")}`,
		`Tech: ${c.tech.join("; ")}`,
		`R&D capacity: ${truncate(c.rd_capacity, 300)}`,
		...c.challenges.map((ch) => `### ${ch.id}\n${ch.text}\nDetail: ${truncate(ch.detail, 1300)}`),
	].join("\n")
}

function toCard(agentId: string, a: AnalystAnswer["challenges"][number], round: number): ChallengeCard | undefined {
	const found = state().ds.challengeById.get(a.challenge_id)
	if (!found) return undefined
	return {
		challengeId: a.challenge_id,
		companyId: found.company.id,
		kind: a.kind,
		why: a.why,
		researchQuestion: a.research_question,
		disciplines: a.disciplines ?? [],
		searchTerms: a.search_terms ?? [],
		collaboration: a.kind === "not_research" ? "none" : a.collaboration,
		quote: a.quote ?? "",
		analyst: agentId,
		round,
		status: "submitted",
	}
}

export function createAnalyst(n: number): Agent {
	let agent: Agent
	const revisions: string[] = []
	let revisionTimer: NodeJS.Timeout | undefined
	let open = 0 // batches and revisions in flight
	let shardDone = false

	const maybeDone = () => {
		if (shardDone && open === 0 && revisions.length === 0) emit("analyst.done", agent.getId(), {})
	}

	async function analyse(companies: Company[], round: number, notes = "", only?: string[]) {
		const s = state()
		const task = round === 0 ? `analyse ${companies.map((c) => c.id).join(",")}` : `revise ${(only ?? []).join(",")}`
		const prompt =
			(notes ? `The critic returned these cards. Fix exactly what it says and answer for these challenges only.\n${notes}\n\n` : "") +
			`Analyse every challenge of these companies:\n\n${companies.map(describeCompany).join("\n\n")}`
		open++
		try {
			const answer = await ask<AnalystAnswer>(agent, { task, prompt, schema: SCHEMA, model: MODELS.fast })
			const wanted = new Set(only ?? companies.flatMap((c) => c.challenges.map((ch) => ch.id)))
			for (const item of answer.challenges ?? []) {
				if (!wanted.has(item.challenge_id)) continue
				const card = toCard(agent.getId(), item, round)
				if (!card) continue
				const previous = s.board.cards.get(card.challengeId)
				if (previous) card.round = previous.round + 1
				s.board.cards.set(card.challengeId, card)
				wanted.delete(card.challengeId)
				emit("challenge.submitted", agent.getId(), { challengeId: card.challengeId, round: card.round, kind: card.kind })
			}
			for (const missing of wanted) emit("challenge.missing", agent.getId(), { challengeId: missing })
		} catch (e) {
			emit("agent.error", agent.getId(), { while: task, error: String((e as Error).message) })
			for (const c of companies) for (const ch of c.challenges) if (!s.board.cards.has(ch.id)) emit("challenge.missing", agent.getId(), { challengeId: ch.id })
		} finally {
			open--
			maybeDone()
		}
	}

	function flushRevisions() {
		revisionTimer = undefined
		const s = state()
		const ids = revisions.splice(0)
		const companies = [...new Set(ids.map((id) => s.ds.challengeById.get(id)!.company))].map((c) => ({
			...c,
			challenges: c.challenges.filter((ch) => ids.includes(ch.id)),
		}))
		const notes = ids
			.map((id) => {
				const card = s.board.cards.get(id)!
				return `- ${id}: your quote was "${card.quote}". Critic: ${card.criticNote}`
			})
			.join("\n")
		void analyse(companies, 1, notes, ids)
	}

	agent = makeAgent(`analyst-${n}`, {
		name: `Industry Analyst ${n}`,
		capabilities: ["inference", "company-analysis"],
		instruction: INSTRUCTION,
		handlers: [
			on<{ agentId: string; companyIds: string[] }>("shard.assigned", async ({ agentId, companyIds }) => {
				if (agentId !== agent.getId()) return
				const s = state()
				const companies = companyIds.map((id) => s.ds.companyById.get(id)!)
				const batch = s.config.analystBatch
				const batches: Company[][] = []
				for (let i = 0; i < companies.length; i += batch) batches.push(companies.slice(i, i + batch))
				// Two batches at a time per analyst; the runner paces the actual requests.
				let next = 0
				const worker = async () => {
					while (next < batches.length) await analyse(batches[next++], 0)
				}
				await Promise.all([worker(), worker()])
				shardDone = true
				maybeDone()
			}),
			on<{ challengeId: string }>("challenge.returned", ({ challengeId }) => {
				const card = state().board.cards.get(challengeId)
				if (!card || card.analyst !== agent.getId()) return
				revisions.push(challengeId)
				revisionTimer ??= setTimeout(flushRevisions, 2_000)
			}),
		],
	})
	return agent
}
