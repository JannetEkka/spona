// Reverse search: which company challenges fit this researcher's work? No model, no network.
// Run: npm run reverse -- R1008
import { Bm25 } from "./data/bm25"
import { loadDataset } from "./data/load"
import { personIds, worksOf } from "./data/people"
import { Library } from "./data/search"
import { termsWithBigrams, truncate } from "./data/text"

const id = process.argv[2]
const ds = loadDataset()
const lib = new Library(ds)
const r = id ? ds.researcherById.get(id) : undefined
if (!r) {
	console.error("usage: npm run reverse -- <researcher id, e.g. R1008>")
	process.exit(1)
}
const status = lib.people.status.get(r.id)!

const index = new Bm25()
const challenges = [...ds.challengeById.values()]
for (const { challenge, company } of challenges) index.add(termsWithBigrams(`${challenge.text} ${challenge.detail} ${company.sector}`))
index.finish()

const records = personIds(lib.people, r.id).map((x) => ds.researcherById.get(x)!)
const works = worksOf(ds, lib.people, r.id).map((p) => ds.publications.get(p)!)
const query = [
	...records.flatMap((x) => [...x.fields, ...x.keywords, ...x.keywords]),
	...works.flatMap((w) => [w.title, ...w.keywords]),
].flatMap((t) => termsWithBigrams(t))

console.log(`# Company challenges that fit the work of ${r.name} (${personIds(lib.people, r.id).join(" = ")})`)
console.log(`${r.title}, ${r.faculty}. Availability: ${status.availability}${status.evidence ? ` ("${status.evidence}")` : ""}.`)
console.log(`Searched ${challenges.length} challenges with ${records.length > 1 ? "both records'" : "the profile's"} fields and keywords and ${works.length} publications. No model was called.\n`)
console.log("| # | challenge | company | words in common |")
console.log("|---|---|---|---|")
index.search(query, 8).forEach((hit, i) => {
	const { challenge, company } = challenges[hit.doc]
	const common = hit.matched.filter((t) => !t.includes("_")).slice(0, 8).join(", ")
	console.log(`| ${i + 1} | **${challenge.id}** ${truncate(challenge.text, 160)} | ${company.name} (${company.sector}) | ${common} |`)
})
