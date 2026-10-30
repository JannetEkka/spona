// A small BM25 index. It is the "cheap search first" step: the whole 7M-token dataset is
// indexed in a few seconds with no model call, and models only see what it surfaces.

export interface Hit {
	doc: number
	score: number
	matched: string[]
}

export class Bm25 {
	private readonly postings = new Map<string, [number, number][]>()
	private readonly lengths: number[] = []
	private avgLength = 0
	private readonly k1 = 1.2
	private readonly b = 0.75

	add(terms: string[]): number {
		const doc = this.lengths.length
		this.lengths.push(terms.length)
		const tf = new Map<string, number>()
		for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
		for (const [t, n] of tf) {
			let list = this.postings.get(t)
			if (!list) this.postings.set(t, (list = []))
			list.push([doc, n])
		}
		return doc
	}

	finish(): void {
		this.avgLength = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length)
	}

	get size(): number {
		return this.lengths.length
	}

	df(term: string): number {
		return this.postings.get(term)?.length ?? 0
	}

	idf(term: string): number {
		const df = this.postings.get(term)?.length ?? 0
		return Math.log(1 + (this.lengths.length - df + 0.5) / (df + 0.5))
	}

	search(queryTerms: string[], limit = 50, filter?: (doc: number) => boolean): Hit[] {
		const scores = new Map<number, number>()
		const matched = new Map<number, Set<string>>()
		for (const term of new Set(queryTerms)) {
			const list = this.postings.get(term)
			if (!list) continue
			const idf = this.idf(term)
			for (const [doc, tf] of list) {
				if (filter && !filter(doc)) continue
				const norm = tf + this.k1 * (1 - this.b + (this.b * this.lengths[doc]) / this.avgLength)
				scores.set(doc, (scores.get(doc) ?? 0) + (idf * (tf * (this.k1 + 1))) / norm)
				let set = matched.get(doc)
				if (!set) matched.set(doc, (set = new Set()))
				set.add(term)
			}
		}
		return [...scores.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([doc, score]) => ({ doc, score, matched: [...(matched.get(doc) ?? [])] }))
	}
}
