// Checks which Gemini models this key can call, with a JSON schema, through Mozaik's Gemini endpoint.
// One tiny request per model. Run: npx tsx scripts/probe-models.ts
import "dotenv/config"
import { GeminiGenerateContent, ModelContext, DeveloperMessageItem, UserMessageItem } from "@mozaik-ai/core"

const apiKey = process.env.GEMINI_API_KEY_NTP
if (!apiKey) throw new Error("GEMINI_API_KEY_NTP is not set")
delete process.env.GEMINI_API_KEY

const models = process.argv.slice(2).length
	? process.argv.slice(2)
	: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash", "gemma-4-26b-a4b-it"]
const endpoint = new GeminiGenerateContent(undefined, { apiKey })
const schema = {
	type: "object",
	properties: { word: { type: "string" }, ids: { type: "array", items: { type: "string" } } },
	required: ["word", "ids"],
}

for (const model of models) {
	const context = ModelContext.create()
		.addContextItem(DeveloperMessageItem.create("Answer in JSON."))
		.addContextItem(UserMessageItem.create('Return word "ok" and ids ["R0001"].'))
	const started = Date.now()
	try {
		const out = await Promise.race([
			endpoint.infer({ model, context, structuredOutput: { schema } }),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 45 s")), 45_000)),
		])
		const text = out.items.map((i: any) => i.content?.text ?? "").join("")
		console.log(model, "ok", Date.now() - started, "ms", text.replace(/\s+/g, "").slice(0, 40), out.tokenUsage?.totalTokens, (out.rowResponse as any)?.modelVersion)
	} catch (e: any) {
		const raw = String(e?.message ?? e)
		console.log(model, "FAILED", raw.match(/"code":\s*\d+/)?.[0] ?? "", raw.match(/quotaId":\s*"[^"]+"|quotaValue":\s*"\d+"/g)?.join(" ") ?? raw.slice(0, 160))
	}
}
