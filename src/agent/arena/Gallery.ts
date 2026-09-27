/**
 * Contact sheets of arena games, for seeing what an agent did rather than
 * only how it scored: one row per game and seat, territory frames at fixed
 * game minutes, each captioned with the agent's land share against the
 * leading nation's. Rows are labelled with what sets their entrant apart:
 * only the options that differ between the entrants shown, with the values
 * each ran (defaults marked).
 *
 *   npm run arena -- --agent a --agent 'a:{"x":2}' --maps World,Mena \
 *     --each-map --play-out --image-every 1 --out arena-results/showcase
 *   npm run arena:gallery -- arena-results/showcase [more result dirs...]
 *
 * Writes into the first results directory: gallery.html (it links the frames
 * in each directory's images/), gallery.json (the labels and each entrant's
 * numbers) and, where Playwright is installed (cloud sessions get it from
 * .claude/hooks/session-start.sh), gallery.jpg, a full-page screenshot that
 * stands on its own. Rows of the same game sit together, so runs with the
 * same seed and maps line up game by game. `npm run arena:progress` files a
 * gallery in the persistent store (docs/progress/).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { PlayerType } from "../../core/game/Game";
import type { ArenaGameResult, LeaderPoint, SeatResult } from "./ArenaGame";
import { isMain } from "./Cli";
import { TERRITORY_LEGEND } from "./TerritoryImage";

export const DEFAULT_MINUTES = [1, 3, 5, 10, 15, 20];

const TICKS_PER_MINUTE = 600;

export interface GalleryFrame {
  label: string;
  /** Image path relative to the gallery page, or null if none was written. */
  image: string | null;
  caption: string;
}

export interface GalleryRow {
  gameID: string;
  map: string;
  agent: string;
  /** Index into `GallerySummary.entrants`. */
  entrant: number;
  outcome: string;
  frames: GalleryFrame[];
}

export interface GalleryEntrant {
  agent: string;
  /** The overrides the entrant was given. */
  options: Record<string, unknown>;
  /** What sets it apart from the other entrants, one item per line. */
  label: string[];
  games: number;
  wins: number;
  eliminated: number;
  /** 1 for a win, else peak land ÷ 0.8, as in the arena summary. */
  meanProgress: number;
  meanPeakShare: number;
}

export interface GallerySummary {
  title: string;
  /** Options that differ between entrants, plus "agent" if agents do. */
  varied: string[];
  entrants: GalleryEntrant[];
  rows: GalleryRow[];
}

/** A game result and the results directory it was read from. */
export interface GalleryInput {
  dir: string;
  result: ArenaGameResult;
  /** The commit the run was played on, if it recorded one ("+" if dirty). */
  build?: string;
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
const minutes = (ticks: number) => `${(ticks / TICKS_PER_MINUTE).toFixed(1)}`;

/** JSON with sorted keys, so equal options compare equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** The options a seat ran with, as far as its result records them. */
const ranWith = (s: SeatResult): Record<string, unknown> => ({
  ...s.resolvedOptions,
  ...s.options,
});

/** What an entrant ran: its agent and every option it ran with, so the same
 *  agent from two builds with different defaults stays two entrants. */
const entrantKey = (s: SeatResult) => `${s.agent}${canonical(ranWith(s))}`;

const show = (v: unknown) =>
  typeof v === "string" ? v : v === undefined ? "?" : canonical(v);

/**
 * Labels for each distinct entrant among `seats`, by `entrantKey`: the agent
 * when agents differ, then every option whose value differs among entrants of
 * the same agent (options only one build of the agent has are left out). A
 * lone entrant of its agent is labelled with its overrides, or "defaults".
 * Entrants whose labels would still be equal (the same agent from different
 * builds) are told apart by the build they ran on.
 */
function entrantLabels(seats: { seat: SeatResult; build?: string }[]): {
  labels: Map<string, string[]>;
  varied: string[];
} {
  const entrants = new Map<string, SeatResult>();
  const builds = new Map<string, string | undefined>();
  for (const { seat: s, build } of seats) {
    if (!entrants.has(entrantKey(s))) {
      entrants.set(entrantKey(s), s);
      builds.set(entrantKey(s), build);
    }
  }
  const all = [...entrants.values()];
  const agentsVary = new Set(all.map((s) => s.agent)).size > 1;
  const varied = new Set<string>(agentsVary ? ["agent"] : []);
  const labels = new Map<string, string[]>();
  for (const [key, s] of entrants) {
    const peers = all.filter((e) => e.agent === s.agent);
    const parts = agentsVary ? [s.agent] : [];
    const overrides = s.options ?? {};
    if (peers.length > 1) {
      const keys = [...new Set(peers.flatMap((p) => Object.keys(ranWith(p))))];
      for (const k of keys) {
        // An option only some builds of the agent know is not a variable.
        if (peers.some((p) => p.resolvedOptions && !(k in ranWith(p)))) {
          continue;
        }
        if (new Set(peers.map((p) => canonical(ranWith(p)[k]))).size < 2) {
          continue;
        }
        varied.add(k);
        const value = ranWith(s)[k];
        parts.push(
          value === undefined
            ? `${k} default`
            : `${k} ${show(value)}${k in overrides ? "" : " (default)"}`,
        );
      }
    } else {
      for (const [k, v] of Object.entries(overrides)) {
        parts.push(`${k} ${show(v)}`);
      }
    }
    labels.set(key, parts.length > 0 ? parts : ["defaults"]);
  }
  // The same agent from builds whose shared options agree: name the build.
  const byLabel = new Map<string, string[]>();
  for (const [key, label] of labels) {
    const l = label.join("\n");
    byLabel.set(l, [...(byLabel.get(l) ?? []), key]);
  }
  for (const keys of byLabel.values()) {
    if (keys.length < 2) continue;
    keys.forEach((key, i) => {
      const build = builds.get(key);
      labels.get(key)!.push(`@${build ?? `run ${i + 1}`}`);
    });
    varied.add("build");
  }
  return { labels, varied: [...varied] };
}

/** "baseline: expandTrigger, expandReserve varied", or one entrant's label. */
function defaultTitle(entrants: GalleryEntrant[], varied: string[]): string {
  const agents = [...new Set(entrants.map((e) => e.agent))];
  if (entrants.length === 1) {
    return `${agents[0]}: ${entrants[0].label.join(", ")}`;
  }
  const options = varied.filter((v) => v !== "agent");
  const who = agents.length > 1 ? agents.join(" vs ") : agents[0];
  return options.length > 0 ? `${who}: ${options.join(", ")} varied` : who;
}

/** The last sample at or before `tick`. */
function at<T extends { tick: number }>(
  points: T[],
  tick: number,
): T | undefined {
  let found: T | undefined;
  for (const p of points) {
    if (p.tick > tick) break;
    found = p;
  }
  return found;
}

function caption(seat: SeatResult, leaders: LeaderPoint[], tick: number) {
  const me = at(seat.timeline, tick);
  const us = me === undefined ? "–" : me.alive ? pct(me.share) : "out";
  const top = at(leaders, tick)?.leaders.find(
    (l) => l.type === PlayerType.Nation,
  );
  return top === undefined
    ? `us ${us}`
    : `us ${us} · top nation ${pct(top.share)}`;
}

function outcome(r: ArenaGameResult, seat: SeatResult): string {
  if (seat.result === "win") return `won at ${minutes(r.ticks)} min`;
  const parts: string[] = [];
  if (seat.eliminatedAtTick !== null) {
    parts.push(`out at ${minutes(seat.eliminatedAtTick)} min`);
  } else if (seat.result === "timeout") {
    parts.push(`alive at the ${minutes(r.ticks)} min cap`);
  }
  parts.push(`peak ${pct(seat.peakShare)}`);
  if (r.winner !== null && !r.winner.isAgent) {
    parts.push(`${r.winner.name} won at ${minutes(r.ticks)} min`);
  }
  if (r.error !== null) parts.push("error");
  return parts.join(" · ");
}

/**
 * Rows (one per game and seat, same games together, in the order the games
 * first appear), the entrants they belong to, and what varies between them.
 * Pure: image paths come from each result's own list, made relative to
 * `galleryDir`.
 */
export function gallery(
  inputs: GalleryInput[],
  galleryDir: string,
  frameMinutes: number[] = DEFAULT_MINUTES,
  title?: string,
): GallerySummary {
  // Runs in the order given, games in run order within each; then every
  // game's rows together, in the order the games first appeared.
  const runOrder = new Map<string, number>();
  for (const { dir } of inputs) {
    if (!runOrder.has(dir)) runOrder.set(dir, runOrder.size);
  }
  const byRun = (a: GalleryInput, b: GalleryInput) =>
    runOrder.get(a.dir)! - runOrder.get(b.dir)! ||
    a.result.index - b.result.index;
  const sorted = [...inputs].sort(byRun);
  const gameOrder = new Map<string, number>();
  for (const { result } of sorted) {
    if (!gameOrder.has(result.gameID)) {
      gameOrder.set(result.gameID, gameOrder.size);
    }
  }
  sorted.sort(
    (a, b) =>
      gameOrder.get(a.result.gameID)! - gameOrder.get(b.result.gameID)! ||
      byRun(a, b),
  );

  const { labels, varied } = entrantLabels(
    sorted.flatMap(({ result, build }) =>
      result.seats.map((seat) => ({ seat, build })),
    ),
  );
  const entrantIndex = new Map<string, number>();
  const entrants: GalleryEntrant[] = [];
  const rows: GalleryRow[] = [];
  for (const { dir, result: r } of sorted) {
    const byTick = new Map<number, string>();
    let final: string | null = null;
    for (const file of r.images) {
      const name = path.basename(file);
      const rel = path
        .relative(galleryDir, path.join(dir, "images", name))
        .split(path.sep)
        .join("/");
      const t = /-t(\d+)\.png$/.exec(name);
      if (t !== null) byTick.set(Number(t[1]), rel);
      else if (name.endsWith("-final.png")) final = rel;
    }
    for (const seat of r.seats) {
      const key = entrantKey(seat);
      if (!entrantIndex.has(key)) {
        entrantIndex.set(key, entrants.length);
        entrants.push({
          agent: seat.agent,
          options: seat.options ?? {},
          label: labels.get(key)!,
          games: 0,
          wins: 0,
          eliminated: 0,
          meanProgress: 0,
          meanPeakShare: 0,
        });
      }
      const entrant = entrantIndex.get(key)!;
      const e = entrants[entrant];
      e.games++;
      if (seat.result === "win") e.wins++;
      if (seat.eliminatedAtTick !== null) e.eliminated++;
      e.meanProgress +=
        seat.result === "win" ? 1 : Math.min(0.99, seat.peakShare / 0.8);
      e.meanPeakShare += seat.peakShare;

      const frames: GalleryFrame[] = frameMinutes.map((m) => {
        const tick = m * TICKS_PER_MINUTE;
        const label = `${m} min`;
        if (tick > r.ticks) return { label, image: null, caption: "ended" };
        return {
          label,
          image: byTick.get(tick) ?? null,
          caption: caption(seat, r.leaders, tick),
        };
      });
      frames.push({
        label: "end",
        image: final,
        caption: `${minutes(r.ticks)} min: ${caption(seat, r.leaders, r.ticks)}`,
      });
      rows.push({
        gameID: r.gameID,
        map: r.map,
        agent: seat.agent,
        entrant,
        outcome: outcome(r, seat),
        frames,
      });
    }
  }
  for (const e of entrants) {
    e.meanProgress = round(e.meanProgress / e.games);
    e.meanPeakShare = round(e.meanPeakShare / e.games);
  }
  return {
    title: title ?? defaultTitle(entrants, varied),
    varied,
    entrants,
    rows,
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** Marker colours that tell entrants apart down the page. */
const ENTRANT_COLOURS = [
  "#f28bd8",
  "#7cc4ff",
  "#ffd166",
  "#8fdc8f",
  "#ff9f7a",
  "#c3a6ff",
];
const entrantColour = (i: number) =>
  ENTRANT_COLOURS[i % ENTRANT_COLOURS.length];

export function galleryHtml(g: GallerySummary, subtitle = ""): string {
  const legend = TERRITORY_LEGEND.map(
    ([name, [r, gr, b]]) =>
      `<span class="swatch" style="background:rgb(${r},${gr},${b})"></span>${escapeHtml(name)}`,
  ).join("");
  const key = g.entrants
    .map(
      (e, i) =>
        `<div class="key" style="border-color:${entrantColour(i)}">` +
        `<div class="agent">${escapeHtml(e.agent)}</div>` +
        `<div class="label">${e.label.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>` +
        `<div class="stats">${e.wins}/${e.games} wins · progress ${e.meanProgress.toFixed(3)} · ` +
        `peak ${pct(e.meanPeakShare)} · out in ${e.eliminated}/${e.games}</div></div>`,
    )
    .join("");
  const header = g.rows[0]?.frames.map((f) => f.label) ?? [];
  const body = g.rows
    .map((row, i) => {
      const first = i === 0 || g.rows[i - 1].gameID !== row.gameID;
      const e = g.entrants[row.entrant];
      const cells = row.frames
        .map(
          (f) =>
            `<td class="frame">${
              f.image === null
                ? `<div class="none"></div>`
                : `<img src="${escapeHtml(f.image)}" alt="">`
            }<div class="cap">${escapeHtml(f.caption)}</div></td>`,
        )
        .join("");
      return (
        `<tr class="${first ? "game" : ""}"><th class="head" style="border-left-color:${entrantColour(row.entrant)}">` +
        `<div class="map">${first ? escapeHtml(row.map) : ""}</div>` +
        `<div class="agent">${escapeHtml(row.agent)}</div>` +
        `<div class="label">${e.label.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>` +
        `<div class="outcome">${escapeHtml(row.outcome)}</div></th>` +
        `${cells}</tr>`
      );
    })
    .join("\n");
  const varied =
    g.entrants.length > 1 && g.varied.length > 0
      ? `varied: ${g.varied.join(", ")} · `
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(g.title)}</title>
<style>
  body { background: #15171b; color: #e4e4e4; margin: 16px;
         font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  .sub { color: #9a9a9a; margin-bottom: 8px; }
  .legend { color: #bdbdbd; margin-bottom: 10px; }
  .swatch { display: inline-block; width: 11px; height: 11px;
            margin: 0 5px 0 14px; vertical-align: -1px; }
  .swatch:first-child { margin-left: 0; }
  .keys { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
  .key { border-left: 4px solid; padding: 2px 10px 2px 8px; background: #1c1f24; }
  table { border-collapse: collapse; }
  th, td { padding: 4px 5px; vertical-align: top; text-align: left; }
  thead th { color: #9a9a9a; font-weight: 500; }
  tr.game > * { border-top: 1px solid #33363c; padding-top: 10px; }
  th.head { width: 200px; font-weight: 400; border-left: 4px solid transparent; }
  .map { font-weight: 600; font-size: 14px; }
  .agent { color: #f28bd8; }
  .label { color: #ffffff; font-weight: 600; font-size: 12.5px; }
  .stats { color: #bdbdbd; font-size: 12px; margin-top: 2px; }
  .outcome { color: #bdbdbd; margin-top: 3px; }
  .frame img, .frame .none { display: block; width: 240px; height: 150px;
            object-fit: contain; background: #0b0d10; }
  .cap { color: #b8b8b8; font-size: 11.5px; margin-top: 3px; }
</style>
</head>
<body>
<h1>${escapeHtml(g.title)}</h1>
<div class="sub">${escapeHtml(varied + subtitle)}</div>
<div class="keys">${key}</div>
<div class="legend">${legend} · other colours: nations</div>
<table>
<thead><tr><th></th>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>
`;
}

// Not a project dependency (the session hook installs it --no-save), so it is
// imported by name at runtime and only where it exists.
const PLAYWRIGHT = "playwright";

/**
 * Full-page screenshot of a local HTML file, as PNG or JPEG by the output's
 * extension; false if Playwright is unavailable.
 */
async function screenshot(
  htmlFile: string,
  imageFile: string,
): Promise<boolean> {
  const pw = await import(PLAYWRIGHT).catch(() => null);
  if (pw === null) return false;
  // Same system-library fallback as .claude/skills/run-openfront/driver.mjs,
  // for hosts where its setup.sh extracted them.
  const env = { ...process.env };
  const cache = path.join(os.homedir(), ".cache", "openfront-run");
  const libs = path.join(cache, "extracted", "usr", "lib", "x86_64-linux-gnu");
  if (fs.existsSync(libs)) {
    env.LD_LIBRARY_PATH = [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    env.FONTCONFIG_FILE = path.join(cache, "fonts.conf");
  }
  const browser = await pw.chromium.launch({
    args: ["--no-sandbox", "--disable-gpu"],
    env,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 900 },
    });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load" });
    const png = imageFile.endsWith(".png");
    // JPEG at 80 is about half the PNG's size and reads the same.
    await page.screenshot({
      path: imageFile,
      fullPage: true,
      ...(png ? {} : { type: "jpeg", quality: 80 }),
    });
  } finally {
    await browser.close();
  }
  return true;
}

function readResults(dir: string): GalleryInput[] {
  const gamesDir = path.join(dir, "games");
  if (!fs.existsSync(gamesDir)) {
    throw new Error(`${dir} has no games/ directory: not an arena results dir`);
  }
  let build: string | undefined;
  const summary = path.join(dir, "summary.json");
  if (fs.existsSync(summary)) {
    const { commit, dirty } = JSON.parse(fs.readFileSync(summary, "utf8")) as {
      commit?: string | null;
      dirty?: boolean | null;
    };
    if (commit) build = `${commit.slice(0, 7)}${dirty ? "+" : ""}`;
  }
  return fs
    .readdirSync(gamesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      dir,
      build,
      result: JSON.parse(
        fs.readFileSync(path.join(gamesDir, f), "utf8"),
      ) as ArenaGameResult,
    }));
}

function describeRuns(dirs: string[]): string {
  return dirs
    .map((dir) => {
      const file = path.join(dir, "summary.json");
      if (!fs.existsSync(file)) return path.basename(dir);
      const { config } = JSON.parse(fs.readFileSync(file, "utf8")) as {
        config: { seed: string; difficulty: string; bots: number };
      };
      return `${path.basename(dir)}: seed ${config.seed}, ${config.difficulty} nations, ${config.bots} tribes`;
    })
    .join(" | ");
}

const HELP = `Usage: npm run arena:gallery -- DIR [DIR...] [options]

  DIR                 arena results directory (run with --image-every 1)
  --minutes a,b,...   game minutes to show (default ${DEFAULT_MINUTES.join(",")}), plus the end
  --out FILE          HTML to write (default: DIR/gallery.html; the JSON and
                      image go beside it)
  --title T           title (default: the agent and what was varied)
  --png               screenshot as PNG instead of JPEG
  --no-image          skip the screenshot
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dirs: string[] = [];
  let frameMinutes = DEFAULT_MINUTES;
  let out: string | null = null;
  let title: string | undefined;
  let image: "jpg" | "png" | null = "jpg";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return;
    } else if (arg === "--minutes") {
      frameMinutes = next()
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (arg === "--out") {
      out = path.resolve(next());
    } else if (arg === "--title") {
      title = next();
    } else if (arg === "--png") {
      image = "png";
    } else if (arg === "--no-image") {
      image = null;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown argument "${arg}" (see --help)`);
    } else {
      dirs.push(path.resolve(arg));
    }
  }
  if (dirs.length === 0) throw new Error(`no results directory\n\n${HELP}`);

  const htmlFile = out ?? path.join(dirs[0], "gallery.html");
  const base = htmlFile.replace(/\.html?$/, "");
  const g = gallery(
    dirs.flatMap(readResults),
    path.dirname(htmlFile),
    frameMinutes,
    title,
  );
  fs.writeFileSync(htmlFile, galleryHtml(g, describeRuns(dirs)));
  fs.writeFileSync(
    `${base}.json`,
    JSON.stringify({ ...g, runs: dirs }, null, 1),
  );
  console.log(`${g.title}: ${g.rows.length} rows → ${htmlFile}`);
  if (image === null) return;
  const imageFile = `${base}.${image}`;
  if (await screenshot(htmlFile, imageFile)) {
    console.log(`screenshot → ${imageFile}`);
  } else {
    console.log("Playwright not installed: no screenshot (open the HTML)");
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
