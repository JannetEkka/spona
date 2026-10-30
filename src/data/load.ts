import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface Researcher {
	id: string
	name: string
	title: string
	institution: string
	faculty: string
	department: string
	fields: string[]
	keywords: string[]
	bio: string
	publications: string[]
	projects: string[]
	patents: string[]
	open_to: string[]
	industry_experience: string
	notes: string
	language: string
}

export interface Author {
	name: string
	researcher_id?: string
	affiliation?: string
}

export interface Publication {
	id: string
	title: string
	abstract: string
	year: number
	venue: string
	type: string
	keywords: string[]
	authors: Author[]
}

export interface Project {
	id: string
	acronym: string
	title: string
	programme: string
	years: string
	summary: string
	partners: unknown[]
	participants: { researcher_id: string; role: string }[]
}

export interface Patent {
	id: string
	title: string
	year: number
	status: string
	abstract: string
	inventors: { researcher_id?: string; name: string }[]
}

export interface Challenge {
	id: string
	text: string
	detail: string
}

export interface Company {
	id: string
	name: string
	sector: string
	employees: number
	founded: number
	location: string
	about: string
	products: string[]
	tech: string[]
	challenges: Challenge[]
	plans: string
	rd_capacity: string
	past_collaborations: string
	language: string
}

export interface CompanyPage {
	id: string // assigned here: <company_id>-P<n>, so pages can be cited too
	company_id: string
	kind: string
	title: string
	date: string
	text: string
}

export interface Dataset {
	dir: string
	researchers: Researcher[]
	publications: Map<string, Publication>
	projects: Map<string, Project>
	patents: Map<string, Patent>
	companies: Company[]
	pages: CompanyPage[]
	researcherById: Map<string, Researcher>
	companyById: Map<string, Company>
	challengeById: Map<string, { challenge: Challenge; company: Company }>
	pagesByCompany: Map<string, CompanyPage[]>
	pageById: Map<string, CompanyPage>
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, "")) as T
}

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as T)
}

export function defaultDataDir(): string {
	return process.env.SPONA_DATA_DIR ?? "data/einstein-matchmaker-data/data"
}

export function loadDataset(dir = defaultDataDir()): Dataset {
	const researchers = readJson<{ researchers: Researcher[] }>(join(dir, "researchers.json")).researchers
	const companies = readJson<{ companies: Company[] }>(join(dir, "companies.json")).companies
	const publications = new Map(readJsonl<Publication>(join(dir, "publications.jsonl")).map((p) => [p.id, p]))
	const projects = new Map(readJson<{ projects: Project[] }>(join(dir, "projects.json")).projects.map((p) => [p.id, p]))
	const patents = new Map(readJson<{ patents: Patent[] }>(join(dir, "patents.json")).patents.map((p) => [p.id, p]))

	const pagesByCompany = new Map<string, CompanyPage[]>()
	const pages: CompanyPage[] = []
	for (const raw of readJsonl<Omit<CompanyPage, "id">>(join(dir, "company-pages.jsonl"))) {
		const list = pagesByCompany.get(raw.company_id) ?? []
		const page = { ...raw, id: `${raw.company_id}-P${list.length + 1}` }
		list.push(page)
		pages.push(page)
		pagesByCompany.set(raw.company_id, list)
	}

	const challengeById = new Map<string, { challenge: Challenge; company: Company }>()
	for (const company of companies) for (const challenge of company.challenges) challengeById.set(challenge.id, { challenge, company })

	return {
		dir,
		researchers,
		publications,
		projects,
		patents,
		companies,
		pages,
		researcherById: new Map(researchers.map((r) => [r.id, r])),
		companyById: new Map(companies.map((c) => [c.id, c])),
		challengeById,
		pagesByCompany,
		pageById: new Map(pages.map((p) => [p.id, p])),
	}
}
