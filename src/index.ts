import exclusiveCSV from "../exclusive.csv";

export interface Env {
	BUCKET: R2Bucket;
	DISCORD_WEBHOOK_URL: string;
}

interface Artist {
	name: string;
	url: string;
	credit: string;
	links_work: number;
	updated: number;
	best: boolean;
}

const CSV_NEEDS_ESCAPE = /[,"\n\r]/;

function toCSVField(val: string): string {
	if (CSV_NEEDS_ESCAPE.test(val)) {
		return `"${val.replace(/"/g, '""')}"`;
	}
	return val;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function toCSVRow(e: Artist): string {
	return `${toCSVField(e.name)},${toCSVField(e.url)},${toCSVField(e.credit)},${e.links_work},${e.updated},${e.best}`;
}

const CSV_HEADER = "name,url,credit,links_work,updated,best";

function serializeCSV(entries: Artist[]): string {
	const rows = entries.map(toCSVRow);
	return rows.length > 0
		? `${CSV_HEADER}\n${rows.join("\n")}\n`
		: `${CSV_HEADER}\n`;
}

function parseCSVLine(input: string, pos: { i: number }): string[] {
	const fields: string[] = [];
	let cur = "";
	let inQuotes = false;
	while (pos.i < input.length) {
		const ch = input[pos.i];
		if (inQuotes) {
			if (ch === '"' && input[pos.i + 1] === '"') {
				cur += '"';
				pos.i += 2;
			} else if (ch === '"') {
				inQuotes = false;
				pos.i++;
			} else {
				cur += ch;
				pos.i++;
			}
		} else {
			if (ch === '"') {
				inQuotes = true;
				pos.i++;
			} else if (ch === ",") {
				fields.push(cur);
				cur = "";
				pos.i++;
			} else if (ch === "\r" && input[pos.i + 1] === "\n") {
				pos.i += 2;
				break;
			} else if (ch === "\n") {
				pos.i++;
				break;
			} else {
				cur += ch;
				pos.i++;
			}
		}
	}
	fields.push(cur);
	return fields;
}

function parseCSV(content: string): Artist[] {
	const raw = content.replace(/^\uFEFF/, "").trim();
	if (!raw) return [];
	const pos = { i: 0 };
	const headers = parseCSVLine(raw, pos);
	const artists: Artist[] = [];
	const row: Record<string, string> = {};
	while (pos.i < raw.length) {
		const vals = parseCSVLine(raw, pos);
		for (let i = 0; i < headers.length; i++) {
			row[headers[i]] = vals[i] ?? "";
		}
		artists.push({
			name: row.name,
			url: row.url,
			credit: row.credit,
			links_work: clamp(Number(row.links_work) || 0, 0, 2),
			updated: Number(row.updated) ? 1 : 0,
			best: (row.best ?? "").toLowerCase() === "true",
		});
	}
	return artists;
}

function unwrapGoogleUrl(href: string): string {
	if (href.startsWith("https://www.google.com/url?")) {
		const qStart = href.indexOf("q=", 28);
		if (qStart === -1) return href;
		const valStart = qStart + 2;
		const ampIndex = href.indexOf("&", valStart);
		const raw =
			ampIndex === -1 ? href.slice(valStart) : href.slice(valStart, ampIndex);
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	return href;
}

const HTML_ENTITY_MAP: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function safeFromCharCode(code: number): string {
	if (code >= 0xd800 && code <= 0xdfff) return "\uFFFD";
	if (code > 0x10ffff) return "\uFFFD";
	return String.fromCharCode(code);
}

function decodeHtmlEntities(s: string): string {
	return s.replace(/&(\w+|#\d+|#x[0-9a-fA-F]+);/g, (match, entity: string) => {
		const named = HTML_ENTITY_MAP[entity];
		if (named) return named;
		if (entity.startsWith("#x"))
			return safeFromCharCode(Number.parseInt(entity.slice(2), 16));
		if (entity.startsWith("#"))
			return safeFromCharCode(Number(entity.slice(1)));
		return match;
	});
}

function stripHtml(s: string): string {
	return s
		.replace(/<br(?:\s[^>]*)?>/gi, "\n")
		.replace(/<\/(?:p|div|li)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const HREF_RE = /href=(["'])([^"']*)\1/;

function parseCell(cell: string): { text: string; url: string } {
	const hrefMatch = cell.match(HREF_RE);
	const text = decodeHtmlEntities(stripHtml(cell));
	let url = "";
	if (hrefMatch) {
		url = unwrapGoogleUrl(decodeHtmlEntities(hrefMatch[2]));
	}
	return { text, url };
}

const NAME_STRIP_RE = /^[^\p{L}\p{N}$]+/u;

function mapLinksWork(val: string): number {
	const lower = val.toLowerCase();
	if (lower === "yes") return 1;
	if (lower === "mostly") return 2;
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

const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
const SHEET_ID_RE = /\/spreadsheets(?:\/u\/\d+)?\/d\/(?:e\/)?([A-Za-z0-9_-]+)/;
const HUB_URL =
	"https://docs.google.com/spreadsheets/u/0/d/1Z8aANbxXbnUGoZPRvJfWL3gz6jrzPPrwVt3d0c1iJ_4/htmlview/sheet?headers=true&gid=1884837542";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function scrapeTrackerHub(): Promise<Artist[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	let html: string;
	try {
		const res = await fetch(HUB_URL, {
			signal: controller.signal,
			headers: { "User-Agent": "TrackerHub/1.0" },
		});
		if (!res.ok) {
			console.error(
				`Failed to fetch tracker hub: ${res.status} ${res.statusText}`,
			);
			return [];
		}
		const buf = await res.arrayBuffer();
		if (buf.byteLength > MAX_BODY_BYTES) {
			console.error(`Tracker hub response too large: ${buf.byteLength} bytes`);
			return [];
		}
		html = new TextDecoder().decode(buf);
	} catch (err) {
		console.error("Failed to fetch tracker hub:", err);
		return [];
	} finally {
		clearTimeout(timeout);
	}

	const entries: Artist[] = [];
	const cells: string[] = [];

	for (const rowMatch of html.matchAll(ROW_RE)) {
		cells.length = 0;
		for (const cellMatch of rowMatch[1].matchAll(CELL_RE)) {
			cells.push(cellMatch[1]);
			if (cells.length === 5) break;
		}
		if (cells.length < 5) continue;

		const tracker = parseCell(cells[1]);
		if (!tracker.url.includes("docs.google.com/spreadsheets")) continue;

		const credits = parseCell(cells[2]).text;
		const updated = parseCell(cells[3]).text;
		const linksWork = parseCell(cells[4]).text;

		const rawName = tracker.text;
		const best = rawName.includes("⭐️");
		const name = rawName.replace(NAME_STRIP_RE, "").trim();
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

const TRENDS_URL = "https://trends.artistgrid.cx/";

async function fetchTrends(): Promise<Map<string, number>> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(TRENDS_URL, {
			signal: controller.signal,
			headers: { "User-Agent": "TrackerHub/1.0" },
		});
		if (!res.ok) {
			console.error(`Failed to fetch trends: ${res.status} ${res.statusText}`);
			return new Map();
		}
		const data = await res.json() as { results: { name: string; visitors: number }[] };
		const map = new Map<string, number>();
		for (const entry of data.results) {
			map.set(entry.name.toLowerCase(), entry.visitors);
		}
		return map;
	} catch (err) {
		console.error("Failed to fetch trends:", err);
		return new Map();
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeUrl(url: string): string {
	if (url.includes("docs.google.com/spreadsheets")) {
		const m = url.match(SHEET_ID_RE);
		return m ? m[1] : url;
	}
	return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function combine(hub: Artist[], exclusives: Artist[]): Artist[] {
	const seen = new Set<string>();
	const out: Artist[] = [];
	for (const entry of hub) {
		if (seen.has(entry.url)) continue;
		seen.add(entry.url);
		out.push(entry);
	}
	for (const entry of exclusives) {
		if (seen.has(entry.url)) continue;
		seen.add(entry.url);
		out.push(entry);
	}
	return out;
}

const EXCLUSIVE_ARTISTS: Artist[] = parseCSV(exclusiveCSV);

interface ArtistDiff {
	added: Artist[];
	removed: Artist[];
}

function computeDiff(oldArtists: Artist[], newArtists: Artist[]): ArtistDiff {
	const oldByUrl = new Map(oldArtists.map((a) => [a.url, a]));
	const newByUrl = new Map(newArtists.map((a) => [a.url, a]));

	const added: Artist[] = [];
	const removed: Artist[] = [];

	for (const [url, artist] of newByUrl) {
		if (!oldByUrl.has(url)) {
			added.push(artist);
		}
	}

	for (const [url, artist] of oldByUrl) {
		if (!newByUrl.has(url)) {
			removed.push(artist);
		}
	}

	return { added, removed };
}

async function notifyDiscord(
	diff: ArtistDiff,
	env: Env,
): Promise<void> {
	const webhookUrl = env.DISCORD_WEBHOOK_URL;
	if (!webhookUrl) {
		console.log("No Discord webhook URL configured, skipping notification");
		return;
	}

	const { added, removed } = diff;
	if (added.length === 0 && removed.length === 0) {
		return;
	}

	const lines: string[] = [];
	if (added.length > 0) {
		lines.push(`**+${added.length} added:**`);
		for (const a of added.slice(0, 25)) {
			lines.push(`• ${a.name}`);
		}
		if (added.length > 25) {
			lines.push(`... and ${added.length - 25} more`);
		}
	}
	if (removed.length > 0) {
		lines.push(`**-${removed.length} removed:**`);
		for (const a of removed.slice(0, 25)) {
			lines.push(`• ${a.name}`);
		}
		if (removed.length > 25) {
			lines.push(`... and ${removed.length - 25} more`);
		}
	}

	const content = `📊 **TrackerHub Update**\n${lines.join("\n")}`;

	try {
		const res = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		});
		if (!res.ok) {
			console.error(`Discord webhook failed: ${res.status} ${res.statusText}`);
		} else {
			console.log("Discord notification sent successfully");
		}
	} catch (err) {
		console.error("Failed to send Discord notification:", err);
	}
}

async function run(env: Env): Promise<void> {
	try {
		const hub = await scrapeTrackerHub();
		const trends = await fetchTrends();
		const artists = combine(hub, EXCLUSIVE_ARTISTS);

		artists.sort((a, b) => {
			const aVisitors = trends.get(a.name.toLowerCase());
			const bVisitors = trends.get(b.name.toLowerCase());
			const aInTrends = aVisitors !== undefined;
			const bInTrends = bVisitors !== undefined;
			if (aInTrends && bInTrends) return bVisitors - aVisitors;
			if (aInTrends) return -1;
			if (bInTrends) return 1;
			if (a.best !== b.best) return a.best ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		const previousObj = await env.BUCKET.get("artists.csv");
		let previousArtists: Artist[] = [];
		if (previousObj) {
			const previousCSV = await previousObj.text();
			previousArtists = parseCSV(previousCSV);
		}

		const diff = computeDiff(previousArtists, artists);

		if (previousArtists.length > 0 && (diff.added.length > 0 || diff.removed.length > 0)) {
			await notifyDiscord(diff, env);
		}

		const artistsCSV = serializeCSV(artists);

		await env.BUCKET.put("artists.csv", artistsCSV, {
			httpMetadata: {
				contentType: "text/csv",
				cacheControl: "public, max-age=300",
			},
		});

		console.log(
			`Done: ${hub.length} hub + ${EXCLUSIVE_ARTISTS.length} exclusives = ${artists.length} artists`,
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
			return new Response("OK", {
				headers: {
					"Content-Type": "text/plain",
					"X-Content-Type-Options": "nosniff",
				},
			});
		}
		return new Response(null, {
			status: 302,
			headers: {
				Location: "https://artists.artistgrid.cx/artists.csv",
				"Cache-Control": "public, max-age=300",
				"X-Content-Type-Options": "nosniff",
			},
		});
	},
	async scheduled(
		_event: ScheduledEvent,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		await run(env);
	},
} satisfies ExportedHandler<Env>;
