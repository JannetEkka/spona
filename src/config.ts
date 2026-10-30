// Models and budgets. Everything runs on the Gemini API free tier.
import type { ModelLimits } from "./llm/runner"

export const MODELS = {
	/** Analysts and profilers: many small, structured jobs. */
	fast: "gemini-3.5-flash-lite",
	/** The critic: fewer calls, needs judgement. */
	judge: "gemini-3-flash-preview",
	/** The proposal writer. */
	writer: "gemini-3.5-flash",
}

// The free tier allows about 20 requests a day per model (quota id
// GenerateRequestsPerDayPerProjectPerModel-FreeTier), so each role has a chain of free models
// with separate quotas. When one is exhausted for the day, overloaded or hanging, the runner
// moves to the next and remembers the exhausted ones until their quota resets.
export const POOLS: Record<string, string[]> = {
	"gemini-3.5-flash-lite": ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-3.8-flash"],
	"gemini-3-flash-preview": ["gemini-3-flash-preview", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
	"gemini-3.5-flash": ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"],
}

/** Conservative pacing per model; 429s push it back further. */
export const LIMITS: Record<string, ModelLimits> = {
	"gemini-3.5-flash-lite": { rpm: 15, concurrency: 4 },
	"gemini-3.1-flash-lite": { rpm: 15, concurrency: 4 },
	"gemini-3-flash-preview": { rpm: 5, concurrency: 2 },
	"gemini-3.5-flash": { rpm: 5, concurrency: 2 },
	"gemini-3.8-flash": { rpm: 5, concurrency: 2 },
}

export interface RunConfig {
	runId: string
	companies?: number // only the first N companies (small runs)
	analysts: number
	profilers: number
	proposals: number
	profileBudget: number // most pairs that get an evidence card (model calls scale with this)
	analystBatch: number // companies per analyst call
	profilerBatch: number // pairs per profiler call
	candidatesPerChallenge: number
	topicFloor: number // pairs below this topic coverage are never profiled
	maxCalls: number // hard cap on model requests for the run
	maxMinutes: number // the coordinator selects with what it has after this
	cache: boolean
	approve: boolean // ask a human to approve the shortlist before writing
	outDir: string
}

export function defaultConfig(runId: string): RunConfig {
	return {
		runId,
		analysts: 3,
		profilers: 3,
		proposals: 4,
		profileBudget: 24,
		analystBatch: 10,
		profilerBatch: 4,
		candidatesPerChallenge: 5,
		topicFloor: 0.4,
		maxCalls: 120,
		maxMinutes: 40,
		cache: true,
		approve: false,
		outDir: `runs/${runId}`,
	}
}
