// Proposal Writer: drafts an industrial PhD topic or a one-page joint project for each selected
// pair, all pairs at the same time, from the verified evidence only. The critic reviews each
// draft as it lands; returned drafts are revised.
import type { Agent } from "@mozaik-ai/core"
import { MODELS } from "../config"
import { truncate } from "../data/text"
import { ask } from "../llm/ask"
import { emit, makeAgent, on, state } from "../runtime"
import type { Pair, Proposal } from "../state"
import { pairPack, source } from "./evidence"

const INSTRUCTION = `You are the Proposal Writer in Spona. You draft proposals that a NTP Novi Sad company and a University of Novi Sad researcher would actually sit down and discuss.
Write in plain, concrete English, like the example shape below. No hype, no filler, no words like crucial, robust, seamless, leverage, cutting-edge, synergy or unique opportunity. Say the number, name the method, state what each side does.
Hard rules:
- Every statement of fact about the company, the researcher or their past work ends with its source id in square brackets, e.g. [SYN-PUB-01234], [SYN-PRJ-0123], [C001-CH1], [C001], [C001-P3], [R0001]. Cite only ids given to you.
- Cite ids exactly as given, nothing added to them. Spell every name exactly as the sources do; if a name is in Cyrillic, give it in Latin script with the Cyrillic in brackets the first time.
- Use only facts in the sources. Don't invent people, job titles, data volumes, equipment, customers, numbers or dates. If the company's industrial supervisor isn't named in the sources, write a role ("the company's head of engineering, to be named").
- Plans, research questions and proposed work are yours to design; make them specific to the challenge and realistic for the company's stated R&D capacity.
- Respect availability notes (sabbaticals, limited capacity, retired = consulting only). If the researcher is a PhD student or assistant, propose co-supervision with a senior colleague in their department, unnamed.
- Never judge or rank the people; explain why the pair fits.
Example shape for an industrial PhD topic (adapt headings for a one-page joint project):
## <title: what gets solved>
**Company:** … **Faculty:** … **Supervisors:** … **Candidate:** …
### The problem
### Research questions (2-3, each measurable)
### Plan (a table by year or by quarter, with a result per row)
### What each side brings
### Why this pair
### Open questions for the first meeting (3)
### Agreed up front (publication and IP, as a proposal)
Answer in JSON only: {"title", "format", "markdown"}.`

const SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		format: { type: "string", enum: ["industrial_phd", "joint_project"] },
		markdown: { type: "string" },
	},
	required: ["title", "format", "markdown"],
}

function today(): string {
	const now = new Date()
	const start = new Date(now.getFullYear(), now.getMonth() + 3, 1)
	return `Today is ${now.toISOString().slice(0, 10)}; plans start no earlier than ${start.toLocaleString("en-GB", { month: "long", year: "numeric" })}.`
}

function writerPack(pair: Pair): string {
	const s = state()
	const card = pair.card!
	const challengeCard = s.board.cards.get(pair.challengeId)!
	const pages = s.lib.pagesFor(pair.companyId, challengeCard.searchTerms, 2)
	const supported = card.claims.filter((c) => c.status === "supported")
	return [
		pairPack(s, pair),
		`\nCompany record:\n- ${source(s, pair.companyId)!.text}`,
		pages.length ? `Company pages that touch this challenge:\n${pages.map((p) => `- ${source(s, p.id)!.text}`).join("\n")}` : "",
		`\nVerified evidence (checked by the critic; build "Why this pair" on these):\n${supported.map((c) => `- ${c.text} [${c.sources.join("] [")}]`).join("\n")}`,
		`What they could solve together (profiler): ${card.jointProblem}`,
		`Known gaps: ${card.gaps.join("; ") || "none stated"}`,
		`Suggested form: ${challengeCard.collaboration === "industrial_phd" ? "industrial PhD topic" : "one-page joint project"}`,
	].join("\n")
}

export function createWriter(): Agent {
	let agent: Agent

	async function draft(pairId: string) {
		const s = state()
		const pair = s.board.pairs.get(pairId)!
		const proposal: Proposal = { pairId, title: "", markdown: "", round: 0, status: "drafting", openIssues: [] }
		s.board.proposals.set(pairId, proposal)
		try {
			const answer = await ask<{ title: string; format: string; markdown: string }>(agent, {
				task: `draft ${pairId}`,
				prompt: `Draft the proposal for this pair. ${today()}\n\n${writerPack(pair)}`,
				schema: SCHEMA,
				model: MODELS.writer,
				reasoningEffort: "low",
			})
			Object.assign(proposal, { title: answer.title, markdown: answer.markdown, status: "submitted" })
			emit("proposal.submitted", agent.getId(), { pair: pairId, round: 0, title: answer.title, chars: answer.markdown.length })
		} catch (e) {
			proposal.status = "accepted"
			proposal.openIssues = [`drafting failed: ${(e as Error).message}`]
			emit("proposal.accepted", agent.getId(), { pair: pairId, round: 0, failed: true })
		}
	}

	async function revise(pairId: string, problems: { quote: string; problem: string }[]) {
		const s = state()
		const pair = s.board.pairs.get(pairId)!
		const proposal = s.board.proposals.get(pairId)!
		try {
			const answer = await ask<{ title: string; format: string; markdown: string }>(agent, {
				task: `revise ${pairId} round ${proposal.round + 1}`,
				prompt:
					`The critic returned your draft. Fix every point: correct the statement so the source supports it, cite the right id, or remove it. Keep everything else.\n\n` +
					`## Critic's points\n${problems.map((p) => `- "${truncate(p.quote, 200)}": ${p.problem}`).join("\n")}\n\n` +
					`## Your draft\n${proposal.markdown}\n\n## Sources\n${writerPack(pair)}`,
				schema: SCHEMA,
				model: MODELS.writer,
				reasoningEffort: "low",
			})
			Object.assign(proposal, { title: answer.title, markdown: answer.markdown, round: proposal.round + 1, status: "submitted" })
		} catch (e) {
			proposal.round++
			emit("agent.error", agent.getId(), { while: `revise ${pairId}`, error: String((e as Error).message) })
		}
		emit("proposal.submitted", agent.getId(), { pair: pairId, round: proposal.round, title: proposal.title, chars: proposal.markdown.length })
	}

	agent = makeAgent("writer", {
		name: "Proposal Writer",
		capabilities: ["inference", "writing"],
		instruction: INSTRUCTION,
		handlers: [
			on<{ pairs: string[] }>("selection.made", ({ pairs }) => {
				for (const id of pairs) void draft(id) // all drafts at once
			}),
			on<{ pair: string; problems: { quote: string; problem: string }[] }>("proposal.returned", ({ pair, problems }) => void revise(pair, problems)),
		],
	})
	return agent
}
