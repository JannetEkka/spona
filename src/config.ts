// Models and budgets. Analysts and profilers run on the Gemini free tier. The critic and the
// writer use Claude Sonnet 4.6 through the hackathon's gateway when its key is set, and free
// Gemini flash models otherwise.
import type { ModelLimits } from "./llm/runner"

/** The JigJoy gateway, under names Claude Code doesn't read (ANTHROPIC_* would redirect it). */
export function claudeGateway(): { apiKey: string; baseURL: string } | undefined {
	const apiKey = process.env.JIGJOY_ANTHROPIC_API_KEY
	const baseURL = process.env.JIGJOY_ANTHROPIC_BASE_URL
	return apiKey && baseURL ? { apiKey, baseURL } : undefined
}

const claude = Boolean(claudeGateway())

export const MODELS = {
	/** Analysts and profilers: many small, structured jobs. */
	fast: "gemini-3.5-flash-lite",
	/** The critic: fewer calls, needs judgement. */
	judge: claude ? "claude-sonnet-4-6" : "gemini-3-flash-preview",
	/** The proposal writer. */
	writer: claude ? "claude-sonnet-4-6" : "gemini-3.5-flash",
}

// The Gemini free tier allows 20 requests a day per flash model (quota id
// GenerateRequestsPerDayPerProjectPerModel-FreeTier), so each role has a chain of models with
// separate quotas. When one is exhausted for the day, out of credit, overloaded or hanging, the
// runner moves to the next and remembers the exhausted ones until their quota resets.
export const POOLS: Record<string, string[]> = {
	"gemini-3.5-flash-lite": ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-3.8-flash"],
	"gemini-3-flash-preview": ["gemini-3-flash-preview", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
	"gemini-3.5-flash": ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"],
	"claude-sonnet-4-6": ["claude-sonnet-4-6", "gemini-3-flash-preview", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"],
}

/** Conservative pacing per model; 429s push it back further. */
export const LIMITS: Record<string, ModelLimits> = {
	"gemini-3.5-flash-lite": { rpm: 15, concurrency: 4 },
	"gemini-3.1-flash-lite": { rpm: 15, concurrency: 4 },
	"gemini-3-flash-preview": { rpm: 5, concurrency: 2 },
	"gemini-3.5-flash": { rpm: 5, concurrency: 2 },
	"gemini-3.8-flash": { rpm: 5, concurrency: 2 },
	"claude-sonnet-4-6": { rpm: 30, concurrency: 4 },
}

/** List prices per million tokens, for the cost line in the trace. Gemini runs on the free tier. */
export const PRICES: Record<string, { input: number; output: number }> = {
	"claude-sonnet-4-6": { input: 3, output: 15 },
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
