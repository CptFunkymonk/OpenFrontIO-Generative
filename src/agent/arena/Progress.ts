/**
 * The persistent record of what the agent looked like: galleries filed in
 * docs/progress/ (committed, so they outlive cloud containers and chats) with
 * a manifest, galleries.json, and a page that shows them all, published as a
 * private claude.ai artifact (docs/11-roadmap.md §11.5 has its link).
 *
 *   npm run arena:gallery -- arena-results/showcase-x
 *   npm run arena:progress -- add arena-results/showcase-x --id reserve-sweep \
 *     --note "what the pictures show" [--note ...]
 *   npm run arena:progress -- page --out arena-results/progress/index.html
 *
 * `add` copies the gallery image to docs/progress/<date>-<id>.<ext> and
 * appends an entry: its title, what was varied, each entrant's label and
 * numbers, and the notes. `page` writes the artifact page and prints the
 * `files` map to publish beside it.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import prettier from "prettier";
import { fileURLToPath } from "url";
import { isMain } from "./Cli";
import type { GalleryEntrant, GallerySummary } from "./Gallery";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
export const PROGRESS_DIR = path.join(ROOT, "docs/progress");
const MANIFEST = path.join(PROGRESS_DIR, "galleries.json");

export interface ProgressEntry {
  id: string;
  date: string;
  /** The checkout the gallery was filed from; "+" if it had local changes. */
  commit: string;
  title: string;
  varied: string[];
  image: string;
  seeds: string[];
  maps: string[];
  games: number;
  entrants: GalleryEntrant[];
  notes: string[];
}

export function readManifest(file = MANIFEST): ProgressEntry[] {
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as ProgressEntry[])
    : [];
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

async function add(argv: string[]): Promise<void> {
  let dir: string | null = null;
  let id: string | null = null;
  let date = new Date().toISOString().slice(0, 10);
  let commit: string | null = null;
  const notes: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    if (arg === "--id") id = next();
    else if (arg === "--note") notes.push(next());
    else if (arg === "--date") date = next();
    else if (arg === "--commit") commit = next();
    else if (arg.startsWith("--")) throw new Error(`unknown argument "${arg}"`);
    else dir = path.resolve(arg);
  }
  if (dir === null || id === null) {
    throw new Error("add needs a gallery directory and --id");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`--id must be lowercase letters, digits and dashes`);
  }
  const summaryFile = path.join(dir, "gallery.json");
  if (!fs.existsSync(summaryFile)) {
    throw new Error(`${dir} has no gallery.json: run npm run arena:gallery`);
  }
  const g = JSON.parse(
    fs.readFileSync(summaryFile, "utf8"),
  ) as GallerySummary & { runs: string[] };
  const source = ["gallery.jpg", "gallery.png"]
    .map((f) => path.join(dir, f))
    .find((f) => fs.existsSync(f));
  if (source === undefined) throw new Error(`${dir} has no gallery image`);

  const entries = readManifest();
  const entryID = `${date}-${id}`;
  if (entries.some((e) => e.id === entryID)) {
    throw new Error(`${entryID} is already filed`);
  }
  const seeds = g.runs.flatMap((run) => {
    const file = path.join(run, "summary.json");
    if (!fs.existsSync(file)) return [];
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as {
      config: { seed: string };
    };
    return [s.config.seed];
  });
  const image = `${entryID}${path.extname(source)}`;
  fs.mkdirSync(PROGRESS_DIR, { recursive: true });
  fs.copyFileSync(source, path.join(PROGRESS_DIR, image));
  // The games ran on this checkout unless --commit says otherwise.
  commit ??=
    git("rev-parse", "--short", "HEAD") +
    (git("status", "--porcelain", "--", "src").length > 0 ? "+" : "");
  entries.push({
    id: entryID,
    date,
    commit,
    title: g.title,
    varied: g.varied,
    image,
    seeds: [...new Set(seeds)],
    maps: [...new Set(g.rows.map((r) => r.map))],
    games: g.rows.length,
    entrants: g.entrants,
    notes,
  });
  const json = await prettier.format(JSON.stringify(entries), {
    ...(await prettier.resolveConfig(MANIFEST)),
    filepath: MANIFEST,
  });
  fs.writeFileSync(MANIFEST, json);
  console.log(`filed ${entryID}: docs/progress/${image}`);
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** Same marker colours as the gallery's entrant key, in the same order. */
const ENTRANT_COLOURS = [
  "#f28bd8",
  "#7cc4ff",
  "#ffd166",
  "#8fdc8f",
  "#ff9f7a",
  "#c3a6ff",
];

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function entrantHtml(e: GalleryEntrant, i: number): string {
  return (
    `<li style="--mark:${ENTRANT_COLOURS[i % ENTRANT_COLOURS.length]}">` +
    `<span class="who">${escapeHtml(e.agent)}</span>` +
    `<span class="vals">${e.label.map(escapeHtml).join(" · ")}</span>` +
    `<span class="nums">${e.wins}/${e.games} wins · progress ${e.meanProgress.toFixed(3)} · ` +
    `peak ${pct(e.meanPeakShare)} · out in ${e.eliminated}/${e.games}</span></li>`
  );
}

/** The newest entry loads eagerly: it is what a first look (or thumbnail) sees. */
function entryHtml(e: ProgressEntry, newest: boolean): string {
  const where = [
    e.seeds.length > 0 ? `seed ${e.seeds.join(", ")}` : null,
    `${e.maps.length} maps`,
    `${e.games} games`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<article class="entry" id="${escapeHtml(e.id)}">
  <p class="meta"><time datetime="${e.date}">${e.date}</time> · commit <code>${escapeHtml(e.commit)}</code> · ${escapeHtml(where)}</p>
  <h2>${escapeHtml(e.title)}</h2>
  <ul class="entrants">${e.entrants.map(entrantHtml).join("")}</ul>
  ${e.notes.length > 0 ? `<ul class="notes">${e.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}
  <figure class="film">
    <button type="button" class="zoom" aria-pressed="false">Actual size</button>
    <div class="frame"><img src="galleries/${escapeHtml(e.image)}" alt="Territory filmstrips: ${escapeHtml(e.title)}"${newest ? "" : ' loading="lazy"'}></div>
    <figcaption>${escapeHtml(e.maps.join(", "))}</figcaption>
  </figure>
</article>`;
}

/** The artifact page: every filed gallery, newest first. */
export function progressPage(entries: ProgressEntry[]): string {
  const newest = [...entries].reverse();
  const index = newest
    .map(
      (e) =>
        `<li><a href="#${escapeHtml(e.id)}"><time datetime="${e.date}">${e.date}</time>` +
        `<span>${escapeHtml(e.title)}</span></a></li>`,
    )
    .join("");
  return `<title>OpenFront Arena Filmstrips</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root {
    --bg: #f3f5f8; --surface: #ffffff; --ink: #18202c; --muted: #5a6475;
    --rule: #d8dde5; --accent: #b3177f; --code: #eceff4;
    --display: "IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif;
    --body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0f141c; --surface: #161d28; --ink: #e5e8ee; --muted: #98a1b0;
      --rule: #273142; --accent: #ff62d3; --code: #1e2633;
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0f141c; --surface: #161d28; --ink: #e5e8ee; --muted: #98a1b0;
    --rule: #273142; --accent: #ff62d3; --code: #1e2633;
    color-scheme: dark;
  }
  body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--body); }
  .page { max-width: 1180px; margin: 0 auto; padding-inline: 20px; padding-block: 28px 64px; }
  header.top { display: grid; gap: 6px; margin-bottom: 24px; }
  h1 { font: 600 30px/1.1 var(--display); margin: 0; text-wrap: balance; }
  .lede .agent { color: var(--accent); font-weight: 600; }
  .lede { color: var(--muted); max-width: 68ch; margin: 0; }
  .index { list-style: none; margin: 0 0 4px; padding: 0; display: grid; gap: 2px;
           border-block: 1px solid var(--rule); padding-block: 10px; }
  .index a { display: flex; gap: 14px; padding: 3px 0; color: var(--ink); text-decoration: none; }
  .index a:hover span, .index a:focus-visible span { color: var(--accent); text-decoration: underline; }
  .index time, .meta time { font: 500 13px/1.6 var(--mono); color: var(--muted);
                            font-variant-numeric: tabular-nums; flex: none; }
  .entry { display: grid; gap: 12px; padding-block: 28px; border-bottom: 1px solid var(--rule); }
  .meta { margin: 0; color: var(--muted); font-size: 13px; }
  code { font: 500 12.5px var(--mono); background: var(--code); padding: 1px 5px; border-radius: 3px; }
  h2 { font: 600 22px/1.2 var(--display); margin: 0; text-wrap: balance; }
  .entrants { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .entrants li { display: grid; grid-template-columns: minmax(90px, auto) 1fr; column-gap: 12px;
                 border-left: 4px solid var(--mark); background: var(--surface);
                 padding: 7px 12px; }
  .who { font-weight: 600; grid-row: span 2; }
  .vals { font: 500 13.5px/1.5 var(--mono); }
  .nums { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .notes { margin: 0; padding-left: 20px; max-width: 80ch; display: grid; gap: 4px; }
  .film { margin: 0; display: grid; gap: 6px; }
  .film .frame { overflow-x: auto; background: #15171b; border: 1px solid var(--rule); }
  .film img { display: block; max-width: 100%; height: auto; }
  .film.actual img { max-width: none; }
  .zoom { justify-self: start; font: 500 13px var(--body); color: var(--ink);
          background: var(--surface); border: 1px solid var(--rule); border-radius: 4px;
          padding: 4px 10px; cursor: pointer; }
  .zoom:hover { border-color: var(--accent); }
  .zoom:focus-visible, .index a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  figcaption { color: var(--muted); font-size: 13px; }
  @media (max-width: 560px) {
    h1 { font-size: 25px; }
    .entrants li { grid-template-columns: 1fr; }
    .who { grid-row: auto; }
  }
</style>
<div class="page">
  <header class="top">
    <h1>OpenFront Arena Filmstrips</h1>
    <p class="lede">Every gallery filed from the headless arena, where the <span class="agent">agent</span> plays against Impossible nations, newest first. Each row of a gallery is one game: the territory at 1, 3, 5, 10, 15 and 20 game minutes and at the end, the agent in magenta with a white outline, captioned with its land share against the top nation's. Rows are labelled with the variables that run changed. Use "Actual size" to read a gallery at full resolution.</p>
  </header>
  <ul class="index">${index}</ul>
  ${newest.map((e, i) => entryHtml(e, i === 0)).join("\n")}
</div>
<script>
  for (const button of document.querySelectorAll(".zoom")) {
    button.addEventListener("click", () => {
      const film = button.closest(".film");
      const actual = film.classList.toggle("actual");
      button.setAttribute("aria-pressed", String(actual));
      button.textContent = actual ? "Fit to width" : "Actual size";
    });
  }
</script>
`;
}

function page(argv: string[]): void {
  let out = path.join(ROOT, "arena-results/progress/index.html");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = path.resolve(argv[++i]);
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  const entries = readManifest();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, progressPage(entries));
  const files = Object.fromEntries(
    entries.map((e) => [
      `galleries/${e.image}`,
      path.relative(process.cwd(), path.join(PROGRESS_DIR, e.image)),
    ]),
  );
  console.log(`${entries.length} galleries → ${out}`);
  console.log(`files to publish beside it:\n${JSON.stringify(files, null, 1)}`);
}

const HELP = `Usage:
  npm run arena:progress -- add GALLERY_DIR --id SLUG [--note TEXT]...
      [--date YYYY-MM-DD] [--commit SHA]
  npm run arena:progress -- page [--out FILE]
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "add") await add(rest);
  else if (command === "page") page(rest);
  else process.stdout.write(HELP);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
