// Fit is a property of a pair (this challenge, this person's work), never of a person.
// Signals used: how much of the challenge's vocabulary appears in the person's own work,
// whether they say they're open to this kind of collaboration, whether they're available,
// and, after the critic, how much of the evidence survived checking.
// Signals deliberately not used: title or seniority, number of publications, citations,
// venue prestige, age, gender, nationality, language of the record.
import type { Candidate } from "../data/search"
import type { Researcher } from "../data/load"
import { fold } from "../data/text"
import type { ChallengeCard, EvidenceCard, Fit } from "../state"

const OPEN_TO: Record<string, RegExp> = {
	industrial_phd: /(ph\.?\s?d|doctoral|doktor|supervis|mentor)/,
	joint_project: /(joint|project|collaborat|partner|zajednick|projek)/,
	contract_research: /(contract|consult|study|testing|ugovor|konsult|ekspertiz|analys)/,
}

const round = (x: number) => Math.round(x * 1000) / 1000

export function preFit(card: ChallengeCard, c: Candidate, r: Researcher): Fit {
	const reasons: string[] = []
	const topic = round(Math.min(1, c.coverage))
	reasons.push(`topic ${topic.toFixed(2)}: ${c.matchedTerms.slice(0, 8).join(", ")}`)

	let availability = 1
	if (c.status.availability === "left") {
		availability = 0
		reasons.push(`not proposed: ${c.status.evidence}`)
	} else if (c.status.availability === "retired") {
		availability = card.collaboration === "contract_research" ? 0.8 : 0.5
		reasons.push(`retired, consulting only: ${c.status.evidence}`)
	}

	let openness = 0
	const open = fold(r.open_to.join(" "))
	const wanted = OPEN_TO[card.collaboration]
	if (wanted && wanted.test(open)) {
		openness = 0.1
		reasons.push(`open to this: "${r.open_to.find((o) => wanted.test(fold(o)))}"`)
	} else if (!r.open_to.length) {
		reasons.push("profile says nothing about what they're open to")
	}

	const total = round(topic * availability + openness)
	return { topic, availability, openness, verdict: 1, evidence: 1, total, reasons }
}

const VERDICT = { strong: 1, plausible: 0.8, weak: 0.5, no_fit: 0 } as const

export function finalFit(pre: Fit, card: EvidenceCard): Fit {
	const supported = card.claims.filter((c) => c.status === "supported").length
	const evidence = supported >= 3 ? 1 : supported === 2 ? 0.85 : supported === 1 ? 0.6 : 0
	const verdict = VERDICT[card.verdict] ?? 0
	const total = round((pre.topic * pre.availability + pre.openness) * verdict * evidence)
	return {
		...pre,
		verdict,
		evidence,
		total,
		reasons: [
			...pre.reasons.filter((r) => !r.startsWith("profiler") && !r.startsWith("evidence")),
			`profiler: ${card.verdict}`,
			`evidence: ${supported} of ${card.claims.length} claims survived the critic`,
		],
	}
}
