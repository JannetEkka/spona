// Source lookup by id, and the evidence packs agents are given. Profilers, the critic and the
// writer all see the same text for the same id, so a claim can be checked against exactly
// what its author read.
import { isAuthorOf, isInventorOf, isOnProject, notesConcern, personIds } from "../data/people"
import { truncate } from "../data/text"
import type { Pair, SponaState } from "../state"

export interface Source {
	id: string
	kind: "publication" | "project" | "patent" | "researcher" | "company" | "challenge" | "page"
	year?: number
	years?: [number, number]
	text: string
}

export function source(s: SponaState, id: string): Source | undefined {
	const ds = s.ds
	const pub = ds.publications.get(id)
	if (pub)
		return {
			id,
			kind: "publication",
			year: pub.year,
			text: `${id} (${pub.year}, ${pub.type}, ${pub.venue}) "${pub.title}". Authors: ${pub.authors.map((a) => a.name).join(", ")}. Keywords: ${pub.keywords.join(", ")}. Abstract: ${pub.abstract ? truncate(pub.abstract, 900) : "(no abstract)"}`,
		}
	const prj = ds.projects.get(id)
	if (prj) {
		const ys = (prj.years.match(/\d{4}/g) ?? []).map(Number)
		return {
			id,
			kind: "project",
			years: ys.length ? [ys[0], ys[ys.length - 1]] : undefined,
			text: `${id} (${prj.years}, ${prj.programme}) "${prj.title}". Participants: ${prj.participants.map((p) => `${p.researcher_id} ${ds.researcherById.get(p.researcher_id)?.name ?? ""} (${p.role})`).join(", ") || "not listed"}. ${truncate(prj.summary, 700)}`,
		}
	}
	const pat = ds.patents.get(id)
	if (pat)
		return {
			id,
			kind: "patent",
			year: pat.year,
			text: `${id} (${pat.year}, ${pat.status}) "${pat.title}". Inventors: ${pat.inventors.map((i) => i.name).join(", ")}. ${pat.abstract ? truncate(pat.abstract, 500) : ""}`,
		}
	const r = ds.researcherById.get(id)
	if (r) return { id, kind: "researcher", text: researcherBrief(s, id) }
	const company = ds.companyById.get(id)
	if (company)
		return {
			id,
			kind: "company",
			text: `${id} ${company.name} (${company.sector}; ${company.employees} people; founded ${company.founded}; ${company.location}). About: ${truncate(company.about, 1400)} Products: ${company.products.join("; ")}. Tech: ${company.tech.join("; ")}. R&D capacity: ${company.rd_capacity} Plans: ${company.plans} Past collaborations: ${company.past_collaborations}`,
		}
	const ch = ds.challengeById.get(id)
	if (ch) return { id, kind: "challenge", text: `${id} (${ch.company.name}): ${ch.challenge.text} Detail: ${ch.challenge.detail}` }
	const page = ds.pageById.get(id)
	if (page) return { id, kind: "page", text: `${id} (${page.kind}, ${page.date}) "${page.title}": ${truncate(page.text, 1200)}` }
	return undefined
}

export function researcherBrief(s: SponaState, id: string): string {
	const ids = personIds(s.lib.people, id)
	const records = ids.map((rid) => s.ds.researcherById.get(rid)!)
	const r = records[0]
	const status = s.lib.people.status.get(id)!
	const concern = records.map((x) => notesConcern(x)).find(Boolean)
	return [
		`${ids.join(" = ")}: ${r.name}, ${r.title}, ${r.faculty}, ${r.department}${ids.length > 1 ? ` (the same person appears under ${ids.length} records: ${records.map((x) => `${x.id} "${x.name}"`).join(", ")})` : ""}`,
		`Fields: ${[...new Set(records.flatMap((x) => x.fields))].join("; ")}`,
		`Keywords: ${[...new Set(records.flatMap((x) => x.keywords))].join("; ")}`,
		`Bio: ${truncate(records.map((x) => x.bio).find(Boolean) ?? "(no bio)", 700)}`,
		`Open to: ${[...new Set(records.flatMap((x) => x.open_to))].join("; ") || "(not stated)"}`,
		`Industry experience: ${truncate(records.map((x) => x.industry_experience).find(Boolean) ?? "(none stated)", 400)}`,
		`Notes: ${concern ? `(not used: ${concern})` : truncate(records.map((x) => x.notes).find(Boolean) ?? "(none)", 500)}`,
		`Availability: ${status.availability}${status.evidence ? ` ("${status.evidence}")` : ""}`,
	].join("\n")
}

/** The ids a claim about this pair may cite. */
export function allowedSources(s: SponaState, pair: Pair): Set<string> {
	const ids = new Set<string>([pair.challengeId, pair.companyId, ...personIds(s.lib.people, pair.researcherId)])
	const company = s.ds.companyById.get(pair.companyId)!
	for (const ch of company.challenges) ids.add(ch.id)
	for (const page of s.ds.pagesByCompany.get(pair.companyId) ?? []) ids.add(page.id)
	return ids
}

/** Does this id belong to this pair? Publications, projects and patents must be the researcher's own. */
export function belongsToPair(s: SponaState, pair: Pair, id: string): { ok: boolean; why?: string } {
	if (allowedSources(s, pair).has(id)) return { ok: true }
	const { ds, lib } = s
	if (ds.publications.has(id)) {
		if (isAuthorOf(ds, lib.people, pair.researcherId, id)) return { ok: true }
		const pub = ds.publications.get(id)!
		const sameName = pub.authors.some((a) => !a.researcher_id && lib.nameKey(a.name) === lib.nameKey(ds.researcherById.get(pair.researcherId)!.name))
		return {
			ok: false,
			why: sameName
				? `${id} lists an author with the same name but it is not on ${pair.researcherId}'s profile and carries no researcher id: a namesake, not this person`
				: `${id} is not a publication of ${pair.researcherId}`,
		}
	}
	if (ds.projects.has(id)) return isOnProject(ds, lib.people, pair.researcherId, id) ? { ok: true } : { ok: false, why: `${pair.researcherId} is not a participant of ${id}` }
	if (ds.patents.has(id)) return isInventorOf(ds, lib.people, pair.researcherId, id) ? { ok: true } : { ok: false, why: `${pair.researcherId} is not an inventor on ${id}` }
	if (ds.researcherById.has(id)) return { ok: false, why: `${id} is a different researcher` }
	if (ds.companyById.has(id) || ds.challengeById.has(id) || ds.pageById.has(id)) return { ok: false, why: `${id} belongs to another company` }
	return { ok: false, why: `${id} does not exist in the dataset` }
}

/** What a profiler or writer is shown about a pair: the challenge, the person, and their matching work. */
export function pairPack(s: SponaState, pair: Pair): string {
	const { challenge, company } = s.ds.challengeById.get(pair.challengeId)!
	const card = s.board.cards.get(pair.challengeId)!
	const c = pair.candidate
	const works = c.works.map((w) => `- ${source(s, w.id)!.text}`)
	const projects = c.projects.map((p) => {
		const role = s.ds.projects.get(p.id)!.participants.find((x) => c.recordIds.includes(x.researcher_id))?.role
		return `- ${source(s, p.id)!.text}${role ? ` Role: ${role}.` : ""}`
	})
	const patents = c.patents.map((p) => `- ${source(s, p.id)!.text}`)
	return [
		`### Pair ${pair.id}`,
		`Challenge ${challenge.id} of ${company.id} ${company.name} (${company.sector}): ${challenge.text}`,
		`Detail: ${truncate(challenge.detail, 900)}`,
		`Analyst's research question: ${card.researchQuestion} (suggested form: ${card.collaboration})`,
		`Researcher profile:\n${researcherBrief(s, pair.researcherId)}`,
		`Evidence you may cite (the researcher's own work, found by search):`,
		...(works.length ? works : ["- (no matching publications)"]),
		...projects,
		...patents,
	].join("\n")
}
