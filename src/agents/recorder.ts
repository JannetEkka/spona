// Observers. The Recorder keeps the trace of the run (every event on the bus, with loop
// timings) and prints a live log. The Cloud Relay sends Spona's own events to Mozaik cloud;
// agent loops already go there from Mozaik itself.
import { createHuman, type Human, SemanticEvent, SituationSpecification, type SituationContext } from "@mozaik-ai/core"
import { createCloudClient } from "@mozaik-ai/cloud-sdk"
import { callTags } from "../llm/runner"
import { state } from "../runtime"

export interface TraceEvent {
	t: number // ms since the run started
	type: string
	by: string
	data: Record<string, unknown>
}

export interface LoopRecord {
	loopId: string
	agent: string
	task: string
	start: number
	end?: number
	model?: string
	tokens?: number
}

const LOOP_EVENTS = new Set([
	"message_received.started",
	"message_received.completed",
	"inference.started",
	"inference.stream",
	"inference.completed",
	"function_call.started",
	"function_call.completed",
	"model.answer",
	"interception.started",
	"interception.finished",
])

class Everything extends SituationSpecification {
	isSatisfiedBy(_: SituationContext): boolean {
		return true
	}
}

function short(value: unknown, max = 400): unknown {
	if (typeof value === "string") return value.length > max ? value.slice(0, max) + "…" : value
	if (Array.isArray(value)) return value.length > 12 ? [...value.slice(0, 12).map((v) => short(v, max)), `… ${value.length - 12} more`] : value.map((v) => short(v, max))
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, short(v, max)]))
	return value
}

const LIVE: Record<string, (d: any) => string> = {
	"run.started": (d) => `run ${d.runId}: ${d.companies} companies, ${d.challenges} challenges, ${d.researchers} researchers, ${d.publications} publications`,
	"shard.assigned": (d) => (d.kind === "companies" ? `${d.agentId} takes ${d.companyIds.length} companies` : `${d.agentId} owns ${d.count} researchers (${d.faculties.length} faculties)`),
	"challenge.submitted": (d) => `${d.challengeId} analysed: ${d.kind}${d.round ? ` (round ${d.round})` : ""}`,
	"challenge.returned": (d) => `CRITIC returned ${d.challengeId}: ${d.reason}`,
	"challenge.no_match": (d) => `${d.challengeId}: no proposal (${d.reason})`,
	"pair.excluded": (d) => `${d.pair} excluded: ${d.reason}`,
	"pair.queued": (d) => `${d.pair} queued for evidence (fit ${d.fit}) → ${d.profiler}`,
	"card.submitted": (d) => `${d.pair} evidence card: ${d.verdict}, ${d.claims} claims${d.round ? ` (round ${d.round})` : ""}`,
	"critic.intervened": (d) => `CRITIC [${d.check}] ${d.targetId}: ${String(d.reason).slice(0, 140)}`,
	"card.returned": (d) => `CRITIC returned ${d.claims.length} claim(s) of ${d.pair} to the profiler`,
	"card.verified": (d) => `${d.pair} verified: ${d.supported} claims kept, ${d.dropped} dropped`,
	"pair.rescored": (d) => `${d.pair} fit ${d.before} → ${d.after} (${d.status})`,
	"ranking.updated": (d) => `ranking: ${d.top.slice(0, 3).map((p: any) => `${p.pair} ${p.fit}`).join(" · ")}`,
	"selection.made": (d) => `selected ${d.pairs.length} pairs for proposals: ${d.pairs.join(", ")}`,
	"proposal.submitted": (d) => `proposal ${d.pair} round ${d.round}: "${d.title}"`,
	"proposal.returned": (d) => `CRITIC returned proposal ${d.pair}: ${d.problems.length} problem(s)`,
	"proposal.accepted": (d) => `proposal ${d.pair} accepted (round ${d.round}, ${d.openIssues ?? 0} open issues)`,
	"agent.error": (d) => `error while ${d.while}: ${String(d.error).slice(0, 160)}`,
	"run.finished": (d) => `finished in ${(d.elapsedMs / 1000).toFixed(0)} s`,
}

export function createRecorder(): { participant: Human; events: TraceEvent[]; loops: Map<string, LoopRecord> } {
	const events: TraceEvent[] = []
	const loops = new Map<string, LoopRecord>()
	const participant = createHuman({
		name: "Recorder",
		capabilities: ["trace"],
		handlers: [
			{
				specification: new Everything(),
				processor: {
					apply({ event }) {
						const s = state()
						const t = s.elapsed()
						const p = (event.payload ?? {}) as any
						if (LOOP_EVENTS.has(event.type)) {
							const loopId = p.loopId as string
							if (event.type === "message_received.started") {
								const tag = callTags.get(p.input?.context?.id)
								loops.set(loopId, { loopId, agent: event.producerId, task: tag?.task ?? "", start: t })
							}
							const loop = loops.get(loopId)
							if (event.type === "inference.completed" && loop) loop.tokens = p.tokenUsage?.totalTokens
							if (event.type === "inference.started" && loop) loop.model = p.model
							if (event.type === "model.answer" && loop) loop.end = t
							if (event.type === "message_received.started" || event.type === "model.answer")
								events.push({ t, type: event.type, by: event.producerId, data: { loopId, task: loop?.task } })
							return
						}
						events.push({ t, type: event.type, by: event.producerId, data: short(p) as Record<string, unknown> })
						const line = LIVE[event.type]?.(p)
						if (line) console.log(`${(t / 1000).toFixed(1).padStart(6)}s  ${event.producerId.padEnd(11)} ${line}`)
					},
				},
			},
		],
	})
	return { participant, events, loops }
}

export function createCloudRelay(runId: string, onUrl: (url: string) => void): { participant: Human; end: () => Promise<void> } | undefined {
	if (!process.env.MOZAIK_API_KEY) return undefined
	const client = createCloudClient({ sessionId: `spona_${runId.replace(/[^a-zA-Z0-9]/g, "_")}`, onSessionUrl: onUrl, onError: () => {} })
	const participant = createHuman({
		name: "Cloud Relay",
		capabilities: ["telemetry"],
		handlers: [
			{
				specification: new Everything(),
				processor: {
					apply({ event }: { event: SemanticEvent }) {
						if (LOOP_EVENTS.has(event.type)) return // Mozaik sends loop events itself
						if (event.type === "participant.joined") {
							const m = event.payload as any
							client.join({ id: m.id, name: m.name, role: m.role === "human" ? "human" : "agent" })
							return
						}
						client.send({ type: event.type, producerId: event.producerId, occurredAt: event.occurredAt, payload: short(event.payload, 2000) })
					},
				},
			},
		],
	})
	return { participant, end: () => client.end() }
}
