/**
 * Named arena presets (docs/11-roadmap.md §11.5): the maps, seed and flags of
 * each evaluation suite, so every run of a suite plays the same games.
 *
 *   npm run arena -- --suite smoke
 *   npm run arena -- --suite dev --agent a --agent b --shard 0/4
 *
 * A suite is a list of arena flags that parseArgs reads before the command
 * line's, so any flag given explicitly overrides the suite's value wherever it
 * appears. Changing a suite changes every later run of it: add a new suite (or
 * a new seed) rather than editing one that ledger rows were measured on.
 */
import { GameMapType } from "../../core/game/Game";

export const SUITE_NAMES = [
  "smoke",
  "showcase",
  "quick",
  "dev",
  "holdout",
] as const;

export type SuiteName = (typeof SUITE_NAMES)[number];

export interface Suite {
  name: SuiteName;
  /** One line for --help: what the suite is for. */
  use: string;
  /** Maps in play order, or null for the default pool (every map with
   *  nations, in the generated map list's order). */
  maps: readonly GameMapType[] | null;
  seed: string;
  /** One game per map per repeat instead of random draws. */
  eachMap: boolean;
  repeat: number;
  /** The suite's other arena flags, as on the command line. */
  flags: readonly string[];
}

/**
 * Four of the smallest maps of the default pool by land tiles (manifest
 * `map.num_land_tiles`), picked to cover each kind of opening: Onion is the
 * smallest map with nations (211k land tiles, 3 nations, all land),
 * ArchipelagoSea the islands (287k, 20 nations, boats needed), FourIslands a
 * small islands FFA (518k, 4 nations) and BeringStrait the two-nation duel
 * (596k). They rank 2nd, 3rd, 10th and 16th of the 127 by land and are all
 * in `quick` too. Oceania, the smallest (198k, 22 nations), is left out:
 * ArchipelagoSea already covers islands crowded with nations.
 */
const SMOKE_MAPS = [
  GameMapType.Onion,
  GameMapType.ArchipelagoSea,
  GameMapType.FourIslands,
  GameMapType.BeringStrait,
];

/** §11.5: continents with many nations, all land, islands, a two-nation duel,
 *  and a crowded map where nations nuke early. */
const SHOWCASE_MAPS = [
  GameMapType.World,
  GameMapType.Europe,
  GameMapType.Alps,
  GameMapType.ArchipelagoSea,
  GameMapType.BeringStrait,
  GameMapType.Mena,
];

/**
 * §11.5, chosen to span the pool: continents (World, Europe, Africa,
 * NorthAmerica), the most nations (GiantWorldMap, 107), all land without
 * ports (Alps, TheBox), the most land (MiddleEast), 6–8% land
 * (ArchipelagoSea, Japan), few nations that win fast (BeringStrait's duel,
 * FourIslands, YellowSea), the smallest (Onion) and 400-tile wide maps
 * (Passage, MississippiRiver).
 *
 * The order is part of the design: a tune's rounds (Tune.ts) play prefixes of
 * the game numbers, so the first 4 games are a continent, islands, all land
 * and the duel; the first 8 add the smallest, a 400-wide map, a second
 * continent and a second islands map; games 8-15 bring each kind but the
 * duel and the smallest again. A first cut is then not made on big
 * continents alone.
 */
const QUICK_MAPS = [
  GameMapType.World,
  GameMapType.ArchipelagoSea,
  GameMapType.Alps,
  GameMapType.BeringStrait,
  GameMapType.Onion,
  GameMapType.Passage,
  GameMapType.Europe,
  GameMapType.FourIslands,
  GameMapType.Japan,
  GameMapType.TheBox,
  GameMapType.MississippiRiver,
  GameMapType.Africa,
  GameMapType.YellowSea,
  GameMapType.MiddleEast,
  GameMapType.GiantWorldMap,
  GameMapType.NorthAmerica,
];

export const SUITES: Record<SuiteName, Suite> = {
  smoke: {
    name: "smoke",
    use: "every change: 4 small maps, isolated and strict, 10-minute cap",
    maps: SMOKE_MAPS,
    seed: "smoke",
    eachMap: true,
    repeat: 1,
    flags: ["--isolate", "--strict", "--max-minutes", "10"],
  },
  showcase: {
    name: "showcase",
    use: "every A/B and milestone: 6 maps played out, an image a minute",
    maps: SHOWCASE_MAPS,
    seed: "showcase",
    eachMap: true,
    repeat: 1,
    flags: ["--play-out", "--image-every", "1"],
  },
  quick: {
    name: "quick",
    use: "screening: 16 maps spanning the pool, twice",
    maps: QUICK_MAPS,
    seed: "quick",
    eachMap: true,
    repeat: 2,
    flags: [],
  },
  dev: {
    name: "dev",
    use: "the adoption test: every map of the default pool, twice",
    maps: null,
    seed: "dev",
    eachMap: true,
    repeat: 2,
    flags: [],
  },
  holdout: {
    name: "holdout",
    use: "milestone sign-off: every map, 3 times, on a seed never tuned on",
    maps: null,
    seed: "holdout",
    eachMap: true,
    repeat: 3,
    flags: [],
  },
};

/** The suite called `name`; throws for an unknown name. */
export function parseSuiteName(name: string): SuiteName {
  const found = SUITE_NAMES.find((n) => n === name);
  if (found === undefined) {
    throw new Error(
      `unknown suite "${name}". Available: ${SUITE_NAMES.join(", ")}`,
    );
  }
  return found;
}

/** The arena flags a suite stands for, read before the command line's. */
export function suiteArgs(name: SuiteName): string[] {
  const s = SUITES[name];
  return [
    ...(s.maps === null ? [] : ["--maps", s.maps.join(",")]),
    "--seed",
    s.seed,
    ...(s.eachMap ? ["--each-map"] : []),
    "--repeat",
    String(s.repeat),
    ...s.flags,
  ];
}

/** --help lines, one per suite. */
export function suitesHelp(indent: string): string {
  return SUITE_NAMES.map(
    (n) => `${indent}${n.padEnd(9)} ${SUITES[n].use}`,
  ).join("\n");
}
