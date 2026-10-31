// Charts for the run's Markdown files, as Mermaid blocks that GitHub renders. Everything drawn
// comes from the run's own data: the plan table the writer wrote, the evidence the critic kept,
// the counts on the board. Nothing is drawn that the run didn't produce.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** Text safe inside a quoted Mermaid flowchart label. */
const label = (s: string) => s.replace(/"/g, "#quot;").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim()
/** Text safe as a Mermaid gantt task name (no colons, semicolons or hashes). */
const taskName = (s: string) =>
	s
		.replace(/\[[^\]]*\]/g, "")
		.replace(/[:;#]/g, " ")
		.replace(/\*\*|`/g, "")
		.replace(/\s+/g, " ")
		.trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s)

/** Breaks a label into lines of about `width` characters for a flowchart node. */
function wrap(s: string, width = 34): string {
	const lines: string[] = []
	let line = ""
	for (const word of s.split(/\s+/)) {
		if (line && (line + " " + word).length > width) {
			lines.push(line)
			line = word
		} else line = line ? `${line} ${word}` : word
	}
	if (line) lines.push(line)
	return lines.join("<br/>")
}

export interface Span {
	start: string // YYYY-MM-DD, first day of the first month
	end: string // YYYY-MM-DD, last day of the last month
}

const pad = (n: number) => String(n).padStart(2, "0")
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate() // m is 1-based
const span = (y1: number, m1: number, y2: number, m2: number): Span | undefined =>
	y2 * 12 + m2 < y1 * 12 + m1 ? undefined : { start: `${y1}-${pad(m1)}-01`, end: `${y2}-${pad(m2)}-${pad(lastDay(y2, m2))}` }

/**
 * Reads a plan period the way the writer writes them: "Q1 2027", "Q3–Q4 2027", "Q3 2027–Q2 2028",
 * "Jan–Jun 2027", "Nov 2027–Feb 2028", "Mar 2027", "Q1 2027 (Jan–Mar)". Relative periods
 * ("Months 1–3", "Year 1") have no calendar date, so they return undefined rather than a guess.
 */
export function parsePeriod(raw: string): Span | undefined {
	const s = raw
		.toLowerCase()
		.replace(/\(.*?\)/g, " ")
		.replace(/[–—−]/g, "-")
		.replace(/\*\*/g, "")
		.replace(/\s+/g, " ")
		.trim()
	const month = (w: string) => MONTHS.indexOf(w.slice(0, 3)) + 1
	let m: RegExpMatchArray | null
	if ((m = s.match(/^q([1-4])(?: (\d{4}))? ?- ?q([1-4]) (\d{4})$/))) {
		const y2 = Number(m[4])
		const y1 = m[2] ? Number(m[2]) : y2
		return span(y1, (Number(m[1]) - 1) * 3 + 1, y2, Number(m[3]) * 3)
	}
	if ((m = s.match(/^q([1-4]) (\d{4})$/))) {
		const q = Number(m[1])
		return span(Number(m[2]), (q - 1) * 3 + 1, Number(m[2]), q * 3)
	}
	if ((m = s.match(/^([a-z]{3,9})\.?(?: (\d{4}))? ?- ?([a-z]{3,9})\.? (\d{4})$/)) && month(m[1]) > 0 && month(m[3]) > 0) {
		const y2 = Number(m[4])
		const y1 = m[2] ? Number(m[2]) : y2
		return span(y1, month(m[1]), y2, month(m[3]))
	}
	if ((m = s.match(/^([a-z]{3,9})\.? (\d{4})$/)) && month(m[1]) > 0) return span(Number(m[2]), month(m[1]), Number(m[2]), month(m[1]))
	return undefined
}

interface PlanRow {
	period: string
	activity: string
	result: string
}

/** The rows of the first table under the proposal's "### Plan" heading. */
export function planRows(markdown: string): { rows: PlanRow[]; tableEnd: number } | undefined {
	const heading = markdown.search(/^###\s+Plan\b/m)
	if (heading < 0) return undefined
	const lines = markdown.slice(heading).split("\n")
	const rows: PlanRow[] = []
	let offset = heading
	let inTable = false
	let tableEnd = -1
	for (const line of lines) {
		offset += line.length + 1
		const isRow = line.trim().startsWith("|")
		if (isRow) {
			inTable = true
			const cells = line.split("|").slice(1, -1).map((c) => c.trim())
			if (cells.length >= 2 && !/^:?-{3,}/.test(cells[0])) rows.push({ period: cells[0], activity: cells[1], result: cells[2] ?? "" })
			tableEnd = offset
		} else if (inTable) break
		else if (/^#{2,3}\s/.test(line) && offset - line.length - 1 > heading) break
	}
	return rows.length > 1 ? { rows: rows.slice(1), tableEnd } : undefined // the first row is the header
}

/** A Gantt chart of the plan table, or undefined when a period has no calendar date. */
export function planGantt(markdown: string): string | undefined {
	const plan = planRows(markdown)
	if (!plan) return undefined
	const tasks = plan.rows.map((r) => ({ ...r, span: parsePeriod(r.period) }))
	if (!tasks.length || tasks.some((t) => !t.span)) return undefined
	return [
		"```mermaid",
		"gantt",
		"    dateFormat YYYY-MM-DD",
		"    axisFormat %b %Y",
		"    todayMarker off",
		"    section Plan",
		// Bars are labelled by step number and period; the numbered table above has the full text.
		...tasks.map((t, i) => `    Step ${i + 1} · ${taskName(t.period).replace(/\s*\(.*$/, "")} : p${i + 1}, ${t.span!.start}, ${t.span!.end}`),
		"```",
	].join("\n")
}

/** Numbers the plan table's rows ("Step 1 · Q1 2027") and puts its Gantt chart right under it. */
export function withPlanGantt(markdown: string): string {
	const plan = planRows(markdown)
	const chart = planGantt(markdown)
	if (!plan || !chart) return markdown
	const heading = markdown.search(/^###\s+Plan\b/m)
	let step = 0
	let header = true
	const table = markdown
		.slice(heading, plan.tableEnd)
		.split("\n")
		.map((line) => {
			if (!line.trim().startsWith("|") || /^\|\s*:?-{3,}/.test(line.trim())) return line
			if (header) {
				header = false
				return line
			}
			step++
			return line.replace(/^(\s*\|\s*)/, `$1**Step ${step}** · `)
		})
		.join("\n")
	return `${markdown.slice(0, heading)}${table.trimEnd()}\n\n${chart}\n${markdown.slice(plan.tableEnd)}`
}

export interface EvidenceItem {
	id: string
	kind: "paper" | "project" | "patent"
	when?: string
	/** Short, complete descriptors (keywords, acronym, role, status): never a cut-off title. */
	tags: string[]
}

/** The company's need, the researcher, and the researcher's own work the critic kept, summarised. */
export function evidenceMap(
	need: { id: string; company: string; tags: string[] },
	researcher: { id: string; name: string },
	items: EvidenceItem[],
	link?: string,
): string | undefined {
	if (!items.length) return undefined
	const lines = (tags: string[]) => tags.map((t) => wrap(label(t), 24)).join("<br/>")
	return [
		"```mermaid",
		"flowchart LR",
		`    need["${label(need.id)}<br/>${wrap(label(need.company), 24)}${need.tags.length ? `<br/><br/>${lines(need.tags)}` : ""}"]`,
		`    who["${wrap(label(researcher.name), 24)}<br/>${label(researcher.id)}"]`,
		...items.map((e, i) => `    e${i + 1}["${label(e.id)}<br/>${label([e.kind, e.when].filter(Boolean).join(" · "))}${e.tags.length ? `<br/><br/>${lines(e.tags)}` : ""}"]`),
		`    need -->${link ? `|"${label(link)}"|` : ""} who`,
		...items.map((_, i) => `    who --> e${i + 1}`),
		"```",
	].join("\n")
}

export interface PairPath {
	challengesTotal: number
	challengeId: string
	kind: string
	collaboration: string
	researchersSearched: number
	candidates: number
	aboveFloor: number
	floorPct: number
	researcher: string
	topicPct: number
	fit: number
	claims: number
	kept: number
	evidencePoints: number
	proposalPoints: number
	rounds: number
}

/** The path from the whole dataset to this one proposal, with the run's own counts. */
export function pairPath(p: PairPath): string {
	const n = (x: number) => x.toLocaleString("en-US")
	const steps = [
		`${n(p.challengesTotal)} company challenges, read by 3 analysts at once`,
		`${p.challengeId}: ${p.kind.replace("_", " ")}; suggested form: ${p.collaboration.replace("_", " ")}`,
		`${n(p.researchersSearched)} researchers searched; ${p.candidates} candidates, ${p.aboveFloor} above the ${p.floorPct}% topic floor`,
		`${p.researcher}: covers ${p.topicPct}% of the challenge's terms; fit ${p.fit}`,
		`Evidence card: ${p.claims} claims, ${p.kept} kept by the critic${p.evidencePoints ? ` after ${p.evidencePoints} sent back` : ""}`,
		`Proposal: ${p.rounds} critic round${p.rounds === 1 ? "" : "s"}${p.proposalPoints ? `, ${p.proposalPoints} point${p.proposalPoints === 1 ? "" : "s"} raised` : ", nothing raised"}`,
	]
	return [
		"```mermaid",
		"flowchart LR",
		...steps.map((s, i) => `    s${i}["${wrap(label(s), 26)}"]`),
		`    ${steps.map((_, i) => `s${i}`).join(" --> ")}`,
		"```",
	].join("\n")
}

/** A Mermaid pie chart; slices with zero are left out. */
export function pie(title: string, slices: [string, number][]): string {
	return ["```mermaid", `pie showData title ${label(title)}`, ...slices.filter(([, v]) => v > 0).map(([k, v]) => `    "${label(k)}" : ${v}`), "```"].join("\n")
}

/** A table with a bar per row, drawn in text so it renders anywhere. */
export function barTable(head: [string, string], rows: [string, number][], width = 24): string {
	const max = Math.max(1, ...rows.map(([, v]) => v))
	return [
		`| ${head[0]} | ${head[1]} | |`,
		"|---|---:|---|",
		...rows.map(([k, v]) => `| ${k.replace(/\|/g, "\\|")} | ${v} | ${"█".repeat(Math.max(1, Math.round((v / max) * width)))} |`),
	].join("\n")
}
