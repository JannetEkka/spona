// The library every agent searches. Built once at start from the whole dataset, no model calls.
import { Bm25 } from "./bm25"
import type { Dataset, Publication, Researcher } from "./load"
import { indexPeople, personIds, worksOf, type PeopleIndex, type PersonStatus } from "./people"
import { fold, termsWithBigrams, tokens } from "./text"

export interface WorkEvidence {
	id: string
	title: string
	year: number
	score: number
	matched: string[]
}

export interface Candidate {
	researcherId: string // the person's main record
	recordIds: string[] // every record of this person (duplicates in Latin and Cyrillic)
	name: string
	status: PersonStatus
	score: number // BM25: best three works plus the profile, so a long publication list doesn't win on its own
	coverage: number // share of the challenge's search terms (IDF-weighted) found in this person's own work
	matchedTerms: string[]
	works: WorkEvidence[]
	projects: { id: string; title: string; matched: string[] }[]
	patents: { id: string; title: string; matched: string[] }[]
	profileMatched: string[]
}

export class Library {
	readonly people: PeopleIndex
	private readonly pubIndex = new Bm25()
	private readonly pubIds: string[] = []
	private readonly profileIndex = new Bm25()
	private readonly profileIds: string[] = []
	/** publication id -> main record ids of the people it belongs to */
	private readonly pubOwners = new Map<string, string[]>()

	constructor(readonly ds: Dataset) {
		this.people = indexPeople(ds)

		for (const r of ds.researchers) {
			if (this.mainRecord(r.id) !== r.id) continue
			for (const pubId of worksOf(ds, this.people, r.id)) this.pubOwners.set(pubId, [...(this.pubOwners.get(pubId) ?? []), r.id])
		}
		for (const pub of ds.publications.values()) {
			if (!this.pubOwners.has(pub.id)) continue // works by nobody with a profile can't be evidence for anyone
			this.pubIds.push(pub.id)
			this.pubIndex.add(termsWithBigrams(this.publicationText(pub)))
		}
		this.pubIndex.finish()

		for (const r of ds.researchers) {
			if (this.mainRecord(r.id) !== r.id) continue
			this.profileIds.push(r.id)
			const text = personIds(this.people, r.id)
				.map((id) => this.profileText(ds.researcherById.get(id)!))
				.join("\n")
			this.profileIndex.add(termsWithBigrams(text))
		}
		this.profileIndex.finish()
	}

	/** The record that stands for this person: the lowest id among their records. */
	mainRecord(id: string): string {
		return [...personIds(this.people, id)].sort()[0]
	}

	publicationText(pub: Publication): string {
		return `${pub.title}. ${pub.title}. ${pub.keywords.join(", ")}. ${pub.keywords.join(", ")}. ${pub.abstract ?? ""}`
	}

	profileText(r: Researcher): string {
		const projects = r.projects.map((id) => this.ds.projects.get(id)).filter((p) => p)
		const patents = r.patents.map((id) => this.ds.patents.get(id)).filter((p) => p)
		return [
			r.fields.join(", "),
			r.fields.join(", "),
			r.keywords.join(", "),
			r.keywords.join(", "),
			r.department,
			r.bio,
			r.industry_experience,
			r.open_to.join(". "),
			...projects.map((p) => `${p!.title}. ${p!.summary}`),
			...patents.map((p) => `${p!.title}. ${p!.abstract}`),
		].join("\n")
	}

	/** Query terms from search phrases: unigrams and bigrams within each phrase, never across phrases. */
	queryTerms(phrases: string[]): string[] {
		const out = new Set<string>()
		for (const phrase of phrases) for (const t of termsWithBigrams(phrase)) out.add(t)
		return [...out]
	}

	findResearchers(phrases: string[], limit = 8): Candidate[] {
		const q = this.queryTerms(phrases)
		if (q.length === 0) return []

		const workScores = new Map<string, WorkEvidence[]>()
		for (const hit of this.pubIndex.search(q, 600)) {
			const pubId = this.pubIds[hit.doc]
			const pub = this.ds.publications.get(pubId)!
			for (const owner of this.pubOwners.get(pubId) ?? []) {
				const list = workScores.get(owner) ?? []
				list.push({ id: pubId, title: pub.title, year: pub.year, score: hit.score, matched: hit.matched })
				workScores.set(owner, list)
			}
		}
		const profileScores = new Map<string, { score: number; matched: string[] }>()
		for (const hit of this.profileIndex.search(q, 200)) {
			profileScores.set(this.profileIds[hit.doc], { score: hit.score, matched: hit.matched })
		}

		const ids = new Set([...workScores.keys(), ...profileScores.keys()])
		const scored = [...ids].map((id) => {
			const works = (workScores.get(id) ?? []).sort((a, b) => b.score - a.score).slice(0, 3)
			const profile = profileScores.get(id)
			const score = works.reduce((s, w) => s + w.score, 0) + 0.5 * (profile?.score ?? 0)
			return { id, works, profile, score }
		})
		scored.sort((a, b) => b.score - a.score)

		// Terms nobody in the library uses (often a Serbian synonym, or an odd phrase) can't be
		// matched by anyone, so they don't count against coverage.
		const matchable = q.filter((t) => this.pubIndex.df(t) > 0 || this.profileIndex.df(t) > 0)
		const totalWeight = matchable.reduce((s, t) => s + this.termWeight(t), 0) || 1
		return scored.slice(0, Math.max(limit * 3, 20)).map(({ id, works, profile, score }) => {
			const r = this.ds.researcherById.get(id)!
			const matched = new Set<string>([...works.flatMap((w) => w.matched), ...(profile?.matched ?? [])])
			const coverage = [...matched].reduce((s, t) => s + this.termWeight(t), 0) / totalWeight
			return {
				researcherId: id,
				recordIds: personIds(this.people, id),
				name: r.name,
				status: this.people.status.get(id)!,
				score,
				coverage,
				matchedTerms: [...matched].filter((t) => !t.includes("_")).slice(0, 20),
				works,
				projects: this.matchingItems(q, personIds(this.people, id).flatMap((rid) => this.ds.researcherById.get(rid)!.projects), "project"),
				patents: this.matchingItems(q, personIds(this.people, id).flatMap((rid) => this.ds.researcherById.get(rid)!.patents), "patent"),
				profileMatched: profile?.matched.filter((t) => !t.includes("_")) ?? [],
			}
		})
			.sort((a, b) => b.coverage * 0.7 + (b.score / scored[0].score) * 0.3 - (a.coverage * 0.7 + (a.score / scored[0].score) * 0.3))
			.slice(0, limit)
	}

	/** Bigrams count for less than their raw IDF, or the rarest phrase would decide everything. */
	private termWeight(term: string): number {
		return term.includes("_") ? 0.5 * this.pubIndex.idf(term) : this.pubIndex.idf(term)
	}

	private matchingItems(q: string[], ids: string[], kind: "project" | "patent") {
		const qs = new Set(q)
		const out: { id: string; title: string; matched: string[] }[] = []
		for (const id of new Set(ids)) {
			const item = kind === "project" ? this.ds.projects.get(id) : this.ds.patents.get(id)
			if (!item) continue
			const text = kind === "project" ? `${item.title}. ${(item as any).summary}` : `${item.title}. ${(item as any).abstract}`
			const matched = [...new Set(termsWithBigrams(text))].filter((t) => qs.has(t))
			if (matched.filter((t) => !t.includes("_")).length >= 2) out.push({ id, title: item.title, matched })
		}
		return out.sort((a, b) => b.matched.length - a.matched.length).slice(0, 3)
	}

	/** Company pages most related to a challenge, so the writer can cite job ads, news or plans. */
	pagesFor(companyId: string, phrases: string[], limit = 2) {
		const q = new Set(this.queryTerms(phrases))
		return (this.ds.pagesByCompany.get(companyId) ?? [])
			.map((page) => ({ page, overlap: new Set(tokens(`${page.title} ${page.text}`).filter((t) => q.has(t))).size }))
			.filter((x) => x.overlap >= 2)
			.sort((a, b) => b.overlap - a.overlap)
			.slice(0, limit)
			.map((x) => x.page)
	}

	nameKey(name: string): string {
		return fold(name)
	}
}
