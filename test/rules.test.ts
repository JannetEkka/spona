// Checks on the rules that need no model. They run against the real dataset.
// Run: npm test (after npm run data)
import assert from "node:assert/strict"
import { test } from "node:test"
import { preFit } from "../src/agents/fit"
import { loadDataset } from "../src/data/load"
import { isAuthorOf, notesConcern, personIds } from "../src/data/people"
import { Library } from "../src/data/search"
import { fold, quoteAppearsIn } from "../src/data/text"
import type { ChallengeCard } from "../src/state"

const ds = loadDataset()
const lib = new Library(ds)

test("Cyrillic and Latin spellings fold to the same text", () => {
	assert.equal(fold("Јелена Марковић"), fold("Jelena Marković"))
	assert.equal(fold("Đorđe"), "djordje")
})

test("a quote must be verbatim; an ellipsis may join two verbatim parts", () => {
	const source = "We have plenty of normal traffic. We have nothing labelled as malicious."
	assert.ok(quoteAppearsIn("We have plenty of normal traffic", source))
	assert.ok(quoteAppearsIn("We have plenty of normal traffic ... nothing labelled as malicious", source))
	assert.ok(!quoteAppearsIn("We have lots of normal traffic", source))
})

test("the same person stored twice (Latin and Cyrillic records) is one person", () => {
	assert.deepEqual(personIds(lib.people, "R0556").sort(), ["R0556", "R0976"])
	assert.deepEqual(personIds(lib.people, "R0894").sort(), ["R0894", "R0929"])
})

test("two different people who share a name are kept apart", () => {
	assert.deepEqual(lib.people.namesakes.get("R0128"), ["R0881"]) // Nina Mamužić, Technology vs Agriculture
	assert.deepEqual(lib.people.namesakes.get("R0191"), ["R0435"]) // Vladan Dobanovački, Medicine vs BioSense
	assert.deepEqual(personIds(lib.people, "R0128"), ["R0128"])
})

test("a paper by a namesake is not this person's paper", () => {
	const r = ds.researchers.find((x) => x.name === "Ana Kovačević")!
	const unlinked = [...ds.publications.values()].find(
		(p) => !r.publications.includes(p.id) && p.authors.some((a) => a.name === "Ana Kovačević" && !a.researcher_id),
	)!
	assert.ok(unlinked, "the dataset has unlinked papers by someone else called Ana Kovačević")
	assert.equal(isAuthorOf(ds, lib.people, r.id, unlinked.id), false)
	assert.equal(isAuthorOf(ds, lib.people, r.id, r.publications[0]), true)
})

test("stale profiles: someone who left is never proposed, retired people are consulting only", () => {
	assert.equal(lib.people.status.get("R0068")!.availability, "left")
	assert.equal(lib.people.status.get("R1000")!.availability, "retired")
})

test("notes that open with someone else's name are flagged", () => {
	assert.match(notesConcern(ds.researcherById.get("R0128")!) ?? "", /Vesna Mitrović/)
	assert.equal(notesConcern(ds.researcherById.get("R0001")!), undefined)
})

test("fit doesn't depend on title or on how many papers someone has", () => {
	const card: ChallengeCard = {
		challengeId: "C001-CH1",
		companyId: "C001",
		kind: "research",
		why: "",
		researchQuestion: "",
		disciplines: [],
		searchTerms: ["anomaly detection", "industrial control systems", "Modbus"],
		collaboration: "industrial_phd",
		quote: "",
		analyst: "test",
		round: 0,
		status: "accepted",
	}
	const [c] = lib.findResearchers(card.searchTerms, 1)
	const r = ds.researcherById.get(c.researcherId)!
	const asStudent = preFit(card, c, { ...r, title: "PhD student", publications: r.publications.slice(0, 1) })
	const asProfessor = preFit(card, c, { ...r, title: "Full Professor", publications: [...r.publications, ...r.publications] })
	assert.equal(asStudent.total, asProfessor.total)
})

test("search finds work on the challenge's topic, without a model", () => {
	const hits = lib.findResearchers(["anomaly detection", "Modbus", "industrial control systems", "unsupervised learning"], 3)
	assert.ok(hits.length > 0)
	assert.ok(hits[0].works.some((w) => /anomal/i.test(w.title)))
})
