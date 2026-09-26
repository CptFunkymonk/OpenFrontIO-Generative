/**
 * Contact sheets of arena games, for seeing what an agent did rather than
 * only how it scored: one row per game and seat, territory frames at fixed
 * game minutes, each captioned with the agent's land share against the
 * leading nation's.
 *
 *   npm run arena -- --agent a --agent b --maps World,Mena --each-map \
 *     --play-out --image-every 1 --out arena-results/showcase
 *   npm run arena:gallery -- arena-results/showcase [more result dirs...]
 *
 * Writes gallery.html into the first results directory (it links the PNGs in
 * each directory's images/) and, where Playwright is installed (cloud
 * sessions get it from .claude/hooks/session-start.sh), gallery.png: a
 * full-page screenshot that can be viewed or committed on its own. Rows of
 * the same game sit together, so two runs with the same seed and maps line
 * up game by game.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { PlayerType } from "../../core/game/Game";
import type { ArenaGameResult, LeaderPoint, SeatResult } from "./ArenaGame";
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
  entrant: string;
  outcome: string;
  frames: GalleryFrame[];
}

/** A game result and the results directory it was read from. */
export interface GalleryInput {
  dir: string;
  result: ArenaGameResult;
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
const minutes = (ticks: number) => `${(ticks / TICKS_PER_MINUTE).toFixed(1)}`;

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
 * One row per game and seat, same games together, in the order the games
 * first appear. Pure: image paths come from each result's own list, made
 * relative to `galleryDir`.
 */
export function galleryRows(
  inputs: GalleryInput[],
  galleryDir: string,
  frameMinutes: number[] = DEFAULT_MINUTES,
): GalleryRow[] {
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
        entrant:
          seat.agent +
          (seat.options !== undefined ? JSON.stringify(seat.options) : ""),
        outcome: outcome(r, seat),
        frames,
      });
    }
  }
  return rows;
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function galleryHtml(
  rows: GalleryRow[],
  title: string,
  subtitle = "",
): string {
  const legend = TERRITORY_LEGEND.map(
    ([name, [r, g, b]]) =>
      `<span class="swatch" style="background:rgb(${r},${g},${b})"></span>${escapeHtml(name)}`,
  ).join("");
  const header = rows[0]?.frames.map((f) => f.label) ?? [];
  const body = rows
    .map((row, i) => {
      const first = i === 0 || rows[i - 1].gameID !== row.gameID;
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
        `<tr class="${first ? "game" : ""}"><th class="head">` +
        `<div class="map">${first ? escapeHtml(row.map) : ""}</div>` +
        `<div class="entrant">${escapeHtml(row.entrant)}</div>` +
        `<div class="outcome">${escapeHtml(row.outcome)}</div></th>` +
        `${cells}</tr>`
      );
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { background: #15171b; color: #e4e4e4; margin: 16px;
         font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  .sub { color: #9a9a9a; margin-bottom: 8px; }
  .legend { color: #bdbdbd; margin-bottom: 12px; }
  .swatch { display: inline-block; width: 11px; height: 11px;
            margin: 0 5px 0 14px; vertical-align: -1px; }
  .swatch:first-child { margin-left: 0; }
  table { border-collapse: collapse; }
  th, td { padding: 4px 5px; vertical-align: top; text-align: left; }
  thead th { color: #9a9a9a; font-weight: 500; }
  tr.game > * { border-top: 1px solid #33363c; padding-top: 10px; }
  th.head { width: 170px; font-weight: 400; }
  .map { font-weight: 600; font-size: 14px; }
  .entrant { color: #f28bd8; word-break: break-all; }
  .outcome { color: #bdbdbd; margin-top: 2px; }
  .frame img, .frame .none { display: block; width: 240px; height: 150px;
            object-fit: contain; background: #0b0d10; }
  .cap { color: #b8b8b8; font-size: 11.5px; margin-top: 3px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="sub">${escapeHtml(subtitle)}</div>
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

/** Full-page PNG of a local HTML file; false if Playwright is unavailable. */
async function screenshot(htmlFile: string, pngFile: string): Promise<boolean> {
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
    await page.screenshot({ path: pngFile, fullPage: true });
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
  return fs
    .readdirSync(gamesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      dir,
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
  --out FILE          HTML to write (default: DIR/gallery.html; PNG beside it)
  --title T           page title
  --no-png            skip the screenshot
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dirs: string[] = [];
  let frameMinutes = DEFAULT_MINUTES;
  let out: string | null = null;
  let title: string | null = null;
  let png = true;
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
    } else if (arg === "--no-png") {
      png = false;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown argument "${arg}" (see --help)`);
    } else {
      dirs.push(path.resolve(arg));
    }
  }
  if (dirs.length === 0) throw new Error(`no results directory\n\n${HELP}`);

  const htmlFile = out ?? path.join(dirs[0], "gallery.html");
  const rows = galleryRows(
    dirs.flatMap(readResults),
    path.dirname(htmlFile),
    frameMinutes,
  );
  fs.writeFileSync(
    htmlFile,
    galleryHtml(rows, title ?? "Arena gallery", describeRuns(dirs)),
  );
  console.log(`${rows.length} rows → ${htmlFile}`);
  if (!png) return;
  const pngFile = htmlFile.replace(/\.html?$/, "") + ".png";
  if (await screenshot(htmlFile, pngFile)) {
    console.log(`screenshot → ${pngFile}`);
  } else {
    console.log("Playwright not installed: no screenshot (open the HTML)");
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
