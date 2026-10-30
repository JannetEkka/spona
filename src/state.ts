// The shared state every participant reads and writes: Mozaik's RuntimeState plus Spona's board.
import { RuntimeState } from "@mozaik-ai/core"
import type { RunConfig } from "./config"
import type { Dataset } from "./data/load"
import type { Candidate, Library } from "./data/search"
import type { SponaRunner } from "./llm/runner"

export type ChallengeKind = "research" | "engineering" | "not_research"
export type Collaboration = "industrial_phd" | "joint_project" | "contract_research" | "none"

export interface ChallengeCard {
	challengeId: string
	companyId: string
	kind: ChallengeKind
	why: string
	researchQuestion: string
	disciplines: string[]
	searchTerms: string[]
	collaboration: Collaboration
	/** Words copied from the company's own text that show the problem, checked verbatim by the critic. */
	quote: string
	analyst: string
	round: number
	status: "submitted" | "returned" | "accepted"
	criticNote?: string
}

export interface Claim {
	id: string // e.g. "C001-CH1~R1015#2"
	text: string
	sources: string[]
	status: "pending" | "supported" | "returned" | "dropped"
	critic?: string
}

export interface EvidenceCard {
	pairId: string
	verdict: "strong" | "plausible" | "weak" | "no_fit"
	jointProblem: string
	claims: Claim[]
	gaps: string[]
	round: number
	profiler: string
}

export interface Fit {
	topic: number
	availability: number
	openness: number
	verdict: number
	evidence: number
	total: number
	reasons: string[]
}

export type PairStatus = "ranked" | "queued" | "profiling" | "reviewing" | "verified" | "rejected" | "excluded"

export interface Pair {
	id: string // "<challengeId>~<researcherId>"
	challengeId: string
	companyId: string
	researcherId: string
	candidate: Candidate
	fit: Fit
	status: PairStatus
	card?: EvidenceCard
	note?: string
}

export interface Proposal {
	pairId: string
	title: string
	markdown: string
	round: number
	status: "drafting" | "submitted" | "returned" | "accepted"
	openIssues: string[]
}

export interface Intervention {
	at: number // ms since run start
	stage: "challenge" | "evidence" | "proposal"
	targetId: string
	author: string
	check: "rule" | "model"
	claim: string
	reason: string
	round: number
	outcome?: "revised" | "withdrawn" | "dropped" | "kept after revision" | "left open"
}

export interface Board {
	runId: string
	startedAt: number
	shards: Record<string, string[]>
	/** researcher id -> the profiler that owns that researcher's shard */
	owner: Map<string, string>
	cards: Map<string, ChallengeCard>
	pairs: Map<string, Pair>
	proposals: Map<string, Proposal>
	interventions: Intervention[]
	selected: string[]
	analystsDone: Set<string>
	challengesTotal: number
	profileBudget: number
	profilesStarted: number
	finished: boolean
}

export class SponaState extends RuntimeState {
	constructor(
		readonly config: RunConfig,
		readonly ds: Dataset,
		readonly lib: Library,
		readonly runner: SponaRunner,
		readonly board: Board,
	) {
		super()
	}

	elapsed(): number {
		return Date.now() - this.board.startedAt
	}
}
