// The one place models are called. It plugs into Mozaik as the runtime's InferenceRunner, so
// every agent loop still runs through Mozaik (and shows up in Mozaik cloud), while this class:
// - passes this entry's key (GEMINI_API_KEY_NTP) explicitly; GEMINI_API_KEY is never read,
// - spaces calls per model to stay inside the free tier, backs off on 429 and falls back to
//   another free model when one is exhausted for the day,
// - caches answers on disk (optional), and
// - writes a ledger line for every call: model, tokens, time, which agent asked and why.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	GeminiGenerateContent,
	ModelMessageItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
	SemanticEvent,
} from "@mozaik-ai/core"

export interface ModelLimits {
	rpm: number
	concurrency: number
}

export interface RunnerOptions {
	apiKey: string
	/** Requested model -> models to try, in order. The first is the requested one. */
	pools: Record<string, string[]>
	limits: Record<string, ModelLimits>
	maxCalls: number
	/** A request that takes longer than this is abandoned and the next model is tried. */
	timeoutMs: number
	cacheDir?: string
	/** Remembers models that are out of free daily quota, and until when, across runs. */
	quotaFile?: string
	onCall?: (entry: LedgerEntry) => void
	onRetry?: (info: { model: string; status: number; waitMs: number; daily: boolean; message: string }) => void
}

export interface CallTag {
	agentId: string
	task: string
}

export interface LedgerEntry {
	n: number
	agentId: string
	task: string
	requestedModel: string
	model: string
	servedModel?: string
	startedAt: string
	ms: number
	inputTokens: number
	outputTokens: number
	thoughtTokens: number
	cached: boolean
	outcome: "ok" | "error"
	error?: string
	retries: number
}

/** Context id -> who is asking and why. Set by `ask()` before it starts a loop. */
export const callTags = new Map<string, CallTag>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Pacer {
	private next = 0
	private active = 0
	private readonly waiters: (() => void)[] = []
	constructor(private readonly limits: ModelLimits) {}

	async acquire(): Promise<void> {
		while (this.active >= this.limits.concurrency) await new Promise<void>((r) => this.waiters.push(r))
		this.active++
		const now = Date.now()
		const at = Math.max(now, this.next)
		this.next = at + Math.ceil(60_000 / this.limits.rpm)
		if (at > now) await sleep(at - now)
	}

	release(): void {
		this.active--
		this.waiters.shift()?.()
	}

	pushBack(ms: number): void {
		this.next = Math.max(this.next, Date.now() + ms)
	}
}

interface ParsedError {
	status: number
	retryMs?: number
	daily: boolean
	message: string
}

function parseError(e: unknown): ParsedError {
	const raw = String((e as any)?.message ?? e)
	const status = Number((e as any)?.status ?? (raw.match(/"code":\s*(\d{3})/)?.[1] ?? 0))
	const delay = raw.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1]
	return {
		status,
		retryMs: delay ? Math.ceil(Number(delay) * 1000) : undefined,
		daily: /PerDay/i.test(raw),
		message: raw.replace(/\s+/g, " ").slice(0, 300),
	}
}

export class SponaRunner implements InferenceRunner {
	private readonly endpoint: GeminiGenerateContent
	private readonly pacers = new Map<string, Pacer>()
	private readonly exhausted = new Map<string, number>() // model -> when its daily quota resets
	private calls = 0
	readonly ledger: LedgerEntry[] = []

	constructor(private readonly options: RunnerOptions) {
		this.endpoint = new GeminiGenerateContent(undefined, { apiKey: options.apiKey })
		if (options.cacheDir) mkdirSync(options.cacheDir, { recursive: true })
		if (options.quotaFile && existsSync(options.quotaFile)) {
			for (const [model, until] of Object.entries(JSON.parse(readFileSync(options.quotaFile, "utf-8")) as Record<string, number>))
				if (until > Date.now()) this.exhausted.set(model, until)
		}
	}

	private markExhausted(model: string, retryMs: number | undefined) {
		this.exhausted.set(model, Date.now() + (retryMs ?? 6 * 3600_000))
		if (this.options.quotaFile) writeFileSync(this.options.quotaFile, JSON.stringify(Object.fromEntries(this.exhausted), null, 1))
	}

	private isExhausted(model: string): boolean {
		const until = this.exhausted.get(model)
		return until !== undefined && until > Date.now()
	}

	private pacer(model: string): Pacer {
		let p = this.pacers.get(model)
		if (!p) this.pacers.set(model, (p = new Pacer(this.options.limits[model] ?? { rpm: 5, concurrency: 1 })))
		return p
	}

	private cacheKey(input: InferenceInput): string {
		const items = input.context.getItems().map((i: any) => [i.type, i.role, i.content?.text ?? i.output?.text ?? i.args ?? ""])
		const body = JSON.stringify([input.model, items, input.structuredOutput?.schema ?? null, input.reasoningEffort ?? null])
		return createHash("sha256").update(body).digest("hex").slice(0, 32)
	}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const tag = callTags.get(input.context.id) ?? { agentId: "unknown", task: "unknown" }
		const started = Date.now()
		const entry: LedgerEntry = {
			n: this.ledger.length + 1,
			agentId: tag.agentId,
			task: tag.task,
			requestedModel: input.model,
			model: input.model,
			startedAt: new Date(started).toISOString(),
			ms: 0,
			inputTokens: 0,
			outputTokens: 0,
			thoughtTokens: 0,
			cached: false,
			outcome: "ok",
			retries: 0,
		}
		const finish = (output: InferenceOutput): InferenceOutput => {
			entry.ms = Date.now() - started
			this.ledger.push(entry)
			this.options.onCall?.(entry)
			return output
		}

		const key = this.cacheKey(input)
		const cachePath = this.options.cacheDir ? join(this.options.cacheDir, `${key}.json`) : undefined
		if (cachePath && existsSync(cachePath)) {
			const hit = JSON.parse(readFileSync(cachePath, "utf-8")) as { model: string; text: string; usage: any }
			Object.assign(entry, { cached: true, model: hit.model, ...hit.usage })
			return finish(this.answer(hit.text, undefined))
		}

		if (this.calls >= this.options.maxCalls) {
			entry.outcome = "error"
			entry.error = `call budget of ${this.options.maxCalls} reached`
			return finish(this.answer(JSON.stringify({ __error: entry.error }), undefined))
		}

		const pool = this.options.pools[input.model] ?? [input.model]
		let lastError = "no model available"
		for (const model of pool) {
			if (this.isExhausted(model)) continue
			entry.model = model
			for (let attempt = 0; attempt < 5; attempt++) {
				const pacer = this.pacer(model)
				await pacer.acquire()
				let timer: NodeJS.Timeout | undefined
				try {
					this.calls++
					const output = await Promise.race([
						this.endpoint.infer({ ...input, model }),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(Object.assign(new Error(`no answer after ${this.options.timeoutMs / 1000} s`), { status: 504 })), this.options.timeoutMs)
						}),
					])
					entry.servedModel = (output.rowResponse as any)?.modelVersion
					const text = output.items
						.filter((i): i is ModelMessageItem => i instanceof ModelMessageItem)
						.map((i) => i.content.text)
						.join("")
					if (!text.trim()) throw new Error("empty answer")
					const usage = {
						inputTokens: output.tokenUsage?.inputTokens ?? 0,
						outputTokens: output.tokenUsage?.outputTokens ?? 0,
						thoughtTokens: output.tokenUsage?.outputTokenDetails?.reasoning_tokens ?? 0,
					}
					Object.assign(entry, usage)
					if (cachePath) writeFileSync(cachePath, JSON.stringify({ model, text, usage }))
					return finish(this.answer(text, output))
				} catch (e) {
					const err = parseError(e)
					lastError = `${model}: ${err.message}`
					entry.retries++
					this.options.onRetry?.({ model, status: err.status, waitMs: err.retryMs ?? 0, daily: err.daily, message: err.message })
					if (err.status === 429 && err.daily) {
						this.markExhausted(model, err.retryMs)
						break
					}
					if (err.status === 429) {
						if ((err.retryMs ?? 0) > 120_000) break // a long wait: better to use another model
						pacer.pushBack(err.retryMs ?? 20_000 * (attempt + 1))
						continue
					}
					if (err.status >= 500 || err.status === 0) {
						if (attempt >= 1) break // overloaded or hanging: try the next model in the pool
						await sleep(3_000)
						continue
					}
					break // 400s won't get better by retrying
				} finally {
					clearTimeout(timer)
					pacer.release()
				}
			}
		}
		entry.outcome = "error"
		entry.error = lastError
		return finish(this.answer(JSON.stringify({ __error: lastError }), undefined))
	}

	/** Always hand the loop exactly one assistant message, so a failed call never breaks Mozaik's state machine. */
	private answer(text: string, output: InferenceOutput | undefined): InferenceOutput {
		return {
			items: [ModelMessageItem.rehydrate({ text })],
			tokenUsage: output?.tokenUsage,
			rowResponse: output?.rowResponse ?? null,
		}
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		const output = await this.run(input)
		yield new SemanticEvent("inference.output", input.model, new Date(), output)
	}

	stats() {
		const byModel: Record<string, { calls: number; cached: number; inputTokens: number; outputTokens: number }> = {}
		for (const e of this.ledger) {
			const m = (byModel[e.model] ??= { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 })
			if (e.cached) m.cached++
			else m.calls++
			m.inputTokens += e.inputTokens
			m.outputTokens += e.outputTokens + e.thoughtTokens
		}
		return { calls: this.calls, exhausted: [...this.exhausted.keys()], byModel }
	}
}
