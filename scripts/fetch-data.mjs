// Clones the EINSTEIN Matchmaker dataset into data/ (about 39 MB).
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"

const target = "data/einstein-matchmaker-data"
if (existsSync(`${target}/data/researchers.json`)) {
	console.log(`dataset already in ${target}`)
} else {
	mkdirSync("data", { recursive: true })
	execFileSync("git", ["clone", "--depth", "1", "https://github.com/jigjoy-ai/einstein-matchmaker-data", target], {
		stdio: "inherit",
	})
}
