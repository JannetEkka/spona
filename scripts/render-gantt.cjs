// Renders the Gantt chart from a run's trace.md to docs/run-gantt.png, for the README.
// Uses the Playwright that ships with the environment and Mermaid from jsDelivr.
// Run: NODE_PATH=$(npm root -g) node scripts/render-gantt.cjs runs/<id>/trace.md docs/run-gantt.png
const { chromium } = require("playwright")
const fs = require("fs")

const [, , tracePath, outPath = "docs/run-gantt.png"] = process.argv
const trace = fs.readFileSync(tracePath, "utf8")
const start = trace.indexOf("```mermaid\n") + "```mermaid\n".length
const code = trace.slice(start, trace.indexOf("```", start))

;(async () => {
	const browser = await chromium.launch()
	const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1600, height: 1200 } })
	await page.setContent('<html><body><script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script></body></html>')
	await page.waitForFunction(() => window.mermaid)
	const svg = await page.evaluate(async (src) => {
		window.mermaid.initialize({ startOnLoad: false, theme: "neutral", gantt: { barHeight: 18, fontSize: 12 } })
		return (await window.mermaid.render("gantt", src)).svg
	}, code)
	await page.setContent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`)
	await (await page.$("svg")).screenshot({ path: outPath })
	await browser.close()
	console.log(`wrote ${outPath}`)
})().catch((e) => {
	console.error(e)
	process.exit(1)
})
