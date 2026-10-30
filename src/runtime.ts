import { Agent, createAgent, defineRuntime, SemanticEvent, SituationSpecification, type SituationContext, type SituationHandler } from "@mozaik-ai/core"
import type { SponaState } from "./state"

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } =
	defineRuntime<SponaState>()

export function state(): SponaState {
	return resolveRuntime().state
}

/** Publish a Spona event on the Mozaik bus. Every joined participant receives it. */
export function emit(type: string, producerId: string, payload: Record<string, unknown>): void {
	sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
}

class EventType extends SituationSpecification {
	constructor(
		private readonly types: string[],
		private readonly fromOthersOnly: boolean,
	) {
		super()
	}
	isSatisfiedBy({ event, participant }: SituationContext): boolean {
		if (!this.types.includes(event.type)) return false
		return !this.fromOthersOnly || event.producerId !== participant.getId()
	}
}

/**
 * A situation handler for one or more event types. The processor runs without blocking the bus;
 * errors are published as `agent.error` instead of crashing the run.
 */
export function on<T = any>(
	types: string | string[],
	fn: (payload: T, event: SemanticEvent, participantId: string) => void | Promise<void>,
	options: { fromOthersOnly?: boolean } = {},
): SituationHandler {
	return {
		specification: new EventType(Array.isArray(types) ? types : [types], options.fromOthersOnly ?? false),
		processor: {
			apply({ event, participant }) {
				Promise.resolve()
					.then(() => fn(event.payload as T, event, participant.getId()))
					.catch((e) => {
						try {
							emit("agent.error", participant.getId(), { while: event.type, error: String(e?.message ?? e) })
						} catch {
							console.error(e)
						}
					})
			},
		},
	}
}

/**
 * createAgent with a readable, stable id ("critic", "analyst-2") instead of a random UUID, so the
 * trace and the shared state can name who did what.
 */
export function makeAgent(
	id: string,
	spec: { name: string; capabilities: string[]; instruction: string; handlers: SituationHandler[] },
): Agent {
	const base = createAgent({ ...spec, tools: [] })
	return new Agent({ id, name: spec.name, capabilities: spec.capabilities, role: "agent" }, spec.instruction, [], base.getMemory(), spec.handlers)
}
