// Checks on the charts: plan periods become calendar spans, and a plan the parser can't date gets
// no chart rather than a guessed one. Run: npm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { parsePeriod, planGantt, withPlanGantt } from "../src/trace/visuals"

test("plan periods in the forms the writer uses become calendar spans", () => {
	assert.deepEqual(parsePeriod("Q1 2027"), { start: "2027-01-01", end: "2027-03-31" })
	assert.deepEqual(parsePeriod("Q3–Q4 2027"), { start: "2027-07-01", end: "2027-12-31" })
	assert.deepEqual(parsePeriod("Q3 2027–Q2 2028"), { start: "2027-07-01", end: "2028-06-30" })
	assert.deepEqual(parsePeriod("Q1 2027 (Jan–Mar)"), { start: "2027-01-01", end: "2027-03-31" })
	assert.deepEqual(parsePeriod("Jan–Jun 2027"), { start: "2027-01-01", end: "2027-06-30" })
	assert.deepEqual(parsePeriod("Nov 2027–Feb 2028"), { start: "2027-11-01", end: "2028-02-29" })
	assert.deepEqual(parsePeriod("Mar 2027"), { start: "2027-03-01", end: "2027-03-31" })
})

test("relative or backwards periods are not dated", () => {
	assert.equal(parsePeriod("Months 1–3"), undefined)
	assert.equal(parsePeriod("Year 1"), undefined)
	assert.equal(parsePeriod("Jun–Jan 2027"), undefined)
})

const draft = `## A title

### Plan
| Period | Activity | Result |
|---|---|---|
| Q1 2027 | Measure the baseline [C001-CH1] | Report |
| Q2–Q3 2027 | Build: the prototype; test it | Prototype |

### What each side brings
Text.`

test("a dated plan gets a Gantt chart right under its table", () => {
	const chart = planGantt(draft)!
	assert.match(chart, /Measure the baseline : p1, 2027-01-01, 2027-03-31/)
	assert.match(chart, /Build the prototype test it : p2, 2027-04-01, 2027-09-30/)
	const out = withPlanGantt(draft)
	assert.ok(out.indexOf("```mermaid") > out.indexOf("| Q2–Q3 2027"))
	assert.ok(out.indexOf("```mermaid") < out.indexOf("### What each side brings"))
})

test("a plan with an undated row gets no chart", () => {
	const undated = draft.replace("Q2–Q3 2027", "Months 4–9")
	assert.equal(planGantt(undated), undefined)
	assert.equal(withPlanGantt(undated), undated)
})
