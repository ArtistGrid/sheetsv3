import exclusiveCSV from "../exclusive.csv";

export interface Env {
	BUCKET: R2Bucket;
}

interface Artist {
	name: string;
	url: string;
	credit: string;
	links_work: number;
	updated: number;
	best: boolean;
}

function splitCSVRow(row: string): string[] {
	const fields: string[] = [];
	let cur = "";
	let inQuotes = false;
	for (let i = 0; i < row.length; i++) {
		const ch = row[i];
		if (inQuotes) {
			if (ch === '"' && row[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') inQuotes = false;
			else cur += ch;
		} else {
			if (ch === '"') inQuotes = true;
			else if (ch === ",") {
				fields.push(cur);
				cur = "";
			} else cur += ch;
		}
	}
	fields.push(cur);
	return fields;
}

function toCSVField(val: string): string {
	if (val.includes(",") || val.includes('"') || val.includes("\n")) {
		return `"${val.replace(/"/g, '""')}"`;
	}
	return val;
}

function toCSVRow(e: Artist): string {
	return [
		toCSVField(e.name),
		toCSVField(e.url),
		toCSVField(e.credit),
		e.links_work,
		e.updated,
		e.best,
	].join(",");
}

function serializeCSV(entries: Artist[]): string {
	const header = "name,url,credit,links_work,updated,best";
	return `${[header, ...entries.map(toCSVRow)].join("\n")}\n`;
}

function parseCSV(content: string): Artist[] {
	const lines = content
		.trim()
		.split("\n")
		.map((l) => l.replace(/\r$/, ""))
		.filter(Boolean);
	const headers = splitCSVRow(lines[0]);
	return lines.slice(1).map((line) => {
		const vals = splitCSVRow(line);
		const row: Record<string, string> = {};
		headers.forEach((h, i) => {
			row[h] = vals[i] ?? "";
		});
		return {
			name: row.name,
			url: row.url,
			credit: row.credit,
			links_work: Number(row.links_work),
			updated: Number(row.updated),
			best: (row.best ?? "").toLowerCase() === "true",
		};
	});
}

function unwrapGoogleUrl(href: string): string {
	if (href.startsWith("https://www.google.com/url?")) {
		try {
			const q = new URL(href).searchParams.get("q");
			return q ?? href;
		} catch {
			return href;
		}
	}
	return href;
}

function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripHtml(s: string): string {
	return s.replace(/<[^>]+>/g, "").trim();
}

function parseCell(cell: string): { text: string; url: string } {
	const hrefMatch = cell.match(/href="([^"]+)"/);
	const text = decodeHtmlEntities(stripHtml(cell));
	let url = "";
	if (hrefMatch) {
		url = unwrapGoogleUrl(decodeHtmlEntities(hrefMatch[1]));
	}
	return { text, url };
}

function mapLinksWork(val: string): number {
	if (val.toLowerCase() === "yes") return 1;
	if (val.toLowerCase() === "mostly") return 2;
	return 0;
}

const BLOCKLIST = new Set([
	"Allegations",
	"Rap Disses Timeline",
	"Underground Artists",
	"BPM & Key Tracker",
	"AI Models",
	"5F",
]);

async function scrapeTrackerHub(): Promise<Artist[]> {
	const res = await fetch(
		"https://docs.google.com/spreadsheets/u/0/d/1Z8aANbxXbnUGoZPRvJfWL3gz6jrzPPrwVt3d0c1iJ_4/htmlview/sheet?headers=true&gid=1884837542",
	);
	if (!res.ok) {
		console.error(
			`Failed to fetch tracker hub: ${res.status} ${res.statusText}`,
		);
		return [];
	}
	const html = await res.text();

	const entries: Artist[] = [];
	const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
	const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;

	for (const rowMatch of html.matchAll(rowRegex)) {
		const cells: string[] = [];
		for (const cellMatch of rowMatch[1].matchAll(cellRegex)) {
			cells.push(cellMatch[1]);
		}
		if (cells.length < 5) continue;

		const tracker = parseCell(cells[1]);
		if (!tracker.url.includes("docs.google.com/spreadsheets")) continue;

		const credits = parseCell(cells[2]).text;
		const updated = parseCell(cells[3]).text;
		const linksWork = parseCell(cells[4]).text;

		const rawName = tracker.text;
		const best = rawName.includes("⭐️");
		const name = rawName.replace(/^[^\p{L}\p{N}]+/u, "").trim();
		if (!name || BLOCKLIST.has(name)) continue;

		entries.push({
			name,
			url: normalizeUrl(tracker.url),
			credit: credits,
			links_work: mapLinksWork(linksWork),
			updated: updated.toLowerCase() === "yes" ? 1 : 0,
			best,
		});
	}

	return entries;
}

function sheetId(url: string): string {
	const m = url.match(
		/\/spreadsheets(?:\/u\/\d+)?\/d\/(?:e\/)?([A-Za-z0-9_-]+)/,
	);
	return m ? m[1] : url;
}

function normalizeUrl(url: string): string {
	if (url.includes("docs.google.com/spreadsheets")) {
		return sheetId(url);
	}
	return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function combine(hub: Artist[], exclusives: Artist[]): Artist[] {
	const seen = new Set<string>();
	const out: Artist[] = [];
	for (const entry of [...hub, ...exclusives]) {
		const key = sheetId(entry.url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}

async function run(env: Env): Promise<void> {
	try {
		const hub = await scrapeTrackerHub();
		const exclusives = parseCSV(exclusiveCSV as unknown as string);
		const artists = combine(hub, exclusives);

		const artistsCSV = serializeCSV(artists);

		await env.BUCKET.put("artists.csv", artistsCSV, {
			httpMetadata: { contentType: "text/csv" },
		});

		console.log(
			`Done: ${hub.length} hub + ${exclusives.length} exclusives = ${artists.length} artists`,
		);
	} catch (err) {
		console.error("Run failed:", err);
		throw err;
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/trigger") {
			await run(env);
			return new Response("OK");
		}
		return Response.redirect("https://artists.artistgrid.cx/artists.csv", 302);
	},
	async scheduled(
		_event: ScheduledEvent,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		await run(env);
	},
} satisfies ExportedHandler<Env>;
