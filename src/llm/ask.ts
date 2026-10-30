// One model question = one Mozaik loop with its own fresh context, so concurrent loops of the
// same agent never share memory. The answer is taken from the loop by an InterceptionHandler
// on the model_message transition, which also tells us exactly which loop it came from.
import {
	DeveloperMessageItem,
	ModelContext,
	type Agent,
	type ExecutableTransition,
	type InterceptionHandler,
	type StructuredOutputFormat,
} from "@mozaik-ai/core"
import { runLoop } from "../runtime"
import { callTags } from "./runner"

export interface AskOptions {
	task: string
	prompt: string
	schema: Record<string, unknown>
	model: string
	reasoningEffort?: "minimal" | "low" | "medium" | "high"
}

function parseJson(text: string): any {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
	return JSON.parse(trimmed)
}

export function ask<T>(agent: Agent, options: AskOptions): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
		callTags.set(context.id, { agentId: agent.getId(), task: options.task })
		const capture: InterceptionHandler = {
			isSatisfiedBy: (t: ExecutableTransition) => t.nextStateId === "model_message",
			async handle(t: ExecutableTransition) {
				callTags.delete(context.id)
				const text = (t.input as { answer: { content: { text: string } } }).answer.content.text
				try {
					const value = parseJson(text)
					if (value && typeof value === "object" && "__error" in value) reject(new Error(String(value.__error)))
					else resolve(value as T)
				} catch {
					reject(new Error(`answer was not valid JSON: ${text.slice(0, 120)}`))
				}
				return t
			},
		}
		const structuredOutput: StructuredOutputFormat = { name: options.task.split(" ")[0], schema: options.schema }
		runLoop(
			agent.getId(),
			options.prompt,
			{ model: options.model, context, structuredOutput, reasoningEffort: options.reasoningEffort },
			capture,
		)
	})
}
