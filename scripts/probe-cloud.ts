// Sends one test session to Mozaik cloud and reports whether the key was accepted.
import "dotenv/config"
import { createCloudClient } from "@mozaik-ai/cloud-sdk"

let failed = false
const client = createCloudClient({
	sessionId: `spona_probe_${Date.now()}`,
	onError: (e) => {
		failed = true
		console.log("mozaik cloud error:", e.message)
	},
})
client.join({ id: "probe", name: "Spona probe", role: "agent" })
client.send({ type: "probe.ping", producerId: "probe", payload: { ok: true } })
await client.end()
console.log(failed ? "not accepted" : "accepted", client.stats())
