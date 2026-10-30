// Checks on people that need no model: who is the same person under two records,
// who only shares a name with someone else, and who is no longer available.
import type { Dataset, Researcher } from "./load"
import { fold } from "./text"

/** Serbian faculty names (Latin or Cyrillic, after folding) to the English names the dataset mostly uses. */
const FACULTY_ALIASES: Record<string, string> = {
	"fakultet tehnickih nauka": "faculty of technical sciences",
	"prirodno-matematicki fakultet": "faculty of sciences",
	"poljoprivredni fakultet": "faculty of agriculture",
	"tehnoloski fakultet": "faculty of technology",
	"medicinski fakultet": "faculty of medicine",
	"filozofski fakultet": "faculty of philosophy",
	"ekonomski fakultet u subotici": "faculty of economics in subotica",
	"pravni fakultet": "faculty of law",
	"akademija umetnosti": "academy of arts",
	"gradjevinski fakultet subotica": "faculty of civil engineering subotica",
	"fakultet sporta i fizickog vaspitanja": "faculty of sport and physical education",
	"pedagoski fakultet u somboru": "faculty of education in sombor",
	"institut biosens": "biosense institute",
	"tehnicki fakultet mihajlo pupin zrenjanin": 'technical faculty "mihajlo pupin" zrenjanin',
}

export function canonicalFaculty(faculty: string): string {
	const f = fold(faculty)
	return FACULTY_ALIASES[f] ?? f
}

export type Availability = "active" | "retired" | "left"

export interface PersonStatus {
	availability: Availability
	/** The sentence from the profile that set the status, quoted so the trace can show why. */
	evidence: string
}

const LEFT = [
	/left the university/i,
	/no longer (affiliated|employed|at|with)/i,
	/has (moved|relocated) to/i,
	/napusti(o|la)/i,
	/vise nije (zaposlen|na)/i,
]
const RETIRED = [/\bretired\b/i, /\bemerit/i, /penzionis/i, /u penziji/i]

function firstSentenceMatching(text: string, patterns: RegExp[]): string | undefined {
	const folded = fold(text)
	if (!patterns.some((p) => p.test(folded))) return undefined
	const sentences = text.split(/(?<=[.!?])\s+/)
	return sentences.find((s) => patterns.some((p) => p.test(fold(s)))) ?? sentences[0]
}

export function statusOf(r: Researcher): PersonStatus {
	const text = `${r.notes ?? ""} ${r.bio ?? ""}`
	const left = firstSentenceMatching(r.notes ?? "", LEFT)
	if (left) return { availability: "left", evidence: left }
	const retired = firstSentenceMatching(`${r.title}. ${text}`, RETIRED)
	if (retired) return { availability: "retired", evidence: retired }
	return { availability: "active", evidence: "" }
}

export interface PeopleIndex {
	status: Map<string, PersonStatus>
	/** Researcher id -> the other record ids of the same person (same name, same faculty and department). */
	sameAs: Map<string, string[]>
	/** Researcher id -> ids of different people with the same name. */
	namesakes: Map<string, string[]>
	/** Folded name -> researcher ids, used to spot unlinked authors who only share a name. */
	byName: Map<string, string[]>
}

export function indexPeople(ds: Dataset): PeopleIndex {
	const byName = new Map<string, string[]>()
	for (const r of ds.researchers) {
		const key = fold(r.name)
		byName.set(key, [...(byName.get(key) ?? []), r.id])
	}
	const sameAs = new Map<string, string[]>()
	const namesakes = new Map<string, string[]>()
	for (const ids of byName.values()) {
		if (ids.length < 2) continue
		for (const id of ids) {
			const r = ds.researcherById.get(id)!
			for (const otherId of ids) {
				if (otherId === id) continue
				const o = ds.researcherById.get(otherId)!
				const same =
					canonicalFaculty(r.faculty) === canonicalFaculty(o.faculty) &&
					(fold(r.department).slice(0, 12) === fold(o.department).slice(0, 12) ||
						r.publications.some((p) => o.publications.includes(p)) ||
						r.projects.some((p) => o.projects.includes(p)) ||
						r.language !== o.language)
				const map = same ? sameAs : namesakes
				map.set(id, [...(map.get(id) ?? []), otherId])
			}
		}
	}
	return {
		status: new Map(ds.researchers.map((r) => [r.id, statusOf(r)])),
		sameAs,
		namesakes,
		byName,
	}
}

/** All record ids that belong to the same person as `id`, including `id`. */
export function personIds(people: PeopleIndex, id: string): string[] {
	return [id, ...(people.sameAs.get(id) ?? [])]
}

/**
 * Is publication `pubId` really this person's work? Only if a profile of this person lists it,
 * or an author entry carries this person's researcher_id. A matching name alone is not enough:
 * two people can share a name.
 */
export function isAuthorOf(ds: Dataset, people: PeopleIndex, researcherId: string, pubId: string): boolean {
	const ids = personIds(people, researcherId)
	const pub = ds.publications.get(pubId)
	if (!pub) return false
	if (ids.some((id) => ds.researcherById.get(id)?.publications.includes(pubId))) return true
	return pub.authors.some((a) => a.researcher_id && ids.includes(a.researcher_id))
}

export function isOnProject(ds: Dataset, people: PeopleIndex, researcherId: string, projectId: string): boolean {
	const ids = personIds(people, researcherId)
	const project = ds.projects.get(projectId)
	if (!project) return false
	if (ids.some((id) => ds.researcherById.get(id)?.projects.includes(projectId))) return true
	return project.participants.some((p) => ids.includes(p.researcher_id))
}

export function isInventorOf(ds: Dataset, people: PeopleIndex, researcherId: string, patentId: string): boolean {
	const ids = personIds(people, researcherId)
	const patent = ds.patents.get(patentId)
	if (!patent) return false
	if (ids.some((id) => ds.researcherById.get(id)?.patents.includes(patentId))) return true
	return patent.inventors.some((i) => i.researcher_id && ids.includes(i.researcher_id))
}

/** Publication ids of this person across all their records. */
export function worksOf(ds: Dataset, people: PeopleIndex, researcherId: string): string[] {
	const out = new Set<string>()
	for (const id of personIds(people, researcherId)) for (const p of ds.researcherById.get(id)?.publications ?? []) out.add(p)
	return [...out].filter((p) => ds.publications.has(p))
}

/**
 * Some profile notes open with somebody else's name (copied from another record). Those notes
 * can't be trusted as facts about this person, so agents are told and the critic won't accept them.
 */
export function notesConcern(r: Researcher): string | undefined {
	const m = (r.notes ?? "").match(/^(?:Prof(?:essor)?\.?\s+|Dr\.?\s+)?([A-ZČĆŠŽĐ][\p{L}'’-]+)(?:\s+([A-ZČĆŠŽĐ][\p{L}'’-]+))?\s+(?:is|has|prefers|was|would|will|can|works)\b/u)
	if (!m) return undefined
	const named = [m[1], m[2]].filter(Boolean).map((x) => fold(x!))
	const own = fold(r.name).split(" ")
	if (named.some((x) => own.includes(x))) return undefined
	if (named[0].endsWith("ly") || ["he", "she", "they", "the", "his", "her", "their", "this", "group", "lab", "available", "open"].includes(named[0]))
		return undefined
	return `notes start with "${m[0].trim()}", which is not ${r.name}; they may belong to another record`
}
