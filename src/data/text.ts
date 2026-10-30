// Text normalisation shared by search and by the critic's checks.
// The dataset mixes English, Serbian Latin and Serbian Cyrillic, so everything is
// transliterated to Latin and stripped of diacritics before it is compared.

const CYRILLIC: Record<string, string> = {
	а: "a", б: "b", в: "v", г: "g", д: "d", ђ: "dj", е: "e", ж: "z", з: "z", и: "i", ј: "j", к: "k",
	л: "l", љ: "lj", м: "m", н: "n", њ: "nj", о: "o", п: "p", р: "r", с: "s", т: "t", ћ: "c", у: "u",
	ф: "f", х: "h", ц: "c", ч: "c", џ: "dz", ш: "s",
}

export function hasCyrillic(text: string): boolean {
	return /[Ѐ-ӿ]/.test(text)
}

/** Lower case, Cyrillic to Latin, no diacritics (đ becomes dj), single spaces. */
export function fold(text: string): string {
	let out = ""
	for (const ch of text.toLowerCase()) out += CYRILLIC[ch] ?? ch
	return out
		.replace(/đ/g, "dj")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\s+/g, " ")
		.trim()
}

const STOPWORDS = new Set(
	(
		"a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
		"may more most no not of on or our over per so such than that the their them then there these they this " +
		"those to too under up us use used using via was we were what when where which while who will with within " +
		"would you your also other new based study paper results approach method methods system systems data " +
		"analysis model models research work need needs want company client clients currently problem one two three " +
		"i u na za se je su od do sa da ili kao koji koja koje sto po iz ka pri o mi vi oni ona ono ce bi " +
		"nas njihov nase naseg nasih ovo ova ovaj taj ta to biti"
	).split(" "),
)

/** Very light English stemming: enough to match "sensors" with "sensor" and "detecting" with "detect". */
function stem(token: string): string {
	if (token.length > 5 && token.endsWith("ies")) return token.slice(0, -3) + "y"
	if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3)
	if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2)
	if (token.length > 4 && token.endsWith("es") && !token.endsWith("ses")) return token.slice(0, -2)
	if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1)
	return token
}

/** Tokens for search: folded, stopwords removed, lightly stemmed. */
export function tokens(text: string): string[] {
	const out: string[] = []
	for (const raw of fold(text).split(/[^a-z0-9]+/)) {
		if (raw.length < 2 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue
		out.push(stem(raw))
	}
	return out
}

/** Tokens plus adjacent pairs, so "anomaly detection" also matches as a phrase. */
export function termsWithBigrams(text: string): string[] {
	const t = tokens(text)
	const out = [...t]
	for (let i = 0; i + 1 < t.length; i++) out.push(`${t[i]}_${t[i + 1]}`)
	return out
}

/**
 * True when the quote appears verbatim in `source`, ignoring case, script, diacritics and
 * punctuation. An ellipsis marks an omission, so each part around it must appear verbatim.
 */
export function quoteAppearsIn(quote: string, source: string): boolean {
	const clean = (x: string) => fold(x).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
	const s = ` ${clean(source)} `
	const parts = quote.split(/\.\.\.|…/).map(clean).filter((p) => p.split(" ").length >= 3)
	return parts.length > 0 && parts.every((p) => s.includes(` ${p} `))
}

export function truncate(text: string, max: number): string {
	if (!text) return ""
	return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, "") + " …"
}

/** A rough test for Serbian text (either script), so English-only word checks can stand aside. */
export function looksSerbian(text: string): boolean {
	if (hasCyrillic(text)) return true
	const words = ` ${fold(text)} `
	return [" je ", " su ", " za ", " od ", " koji ", " koja ", " sa ", " na ", " u ", " i ", " se "].filter((w) => words.includes(w)).length >= 5
}
