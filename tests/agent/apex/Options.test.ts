import fs from "node:fs";
import path from "node:path";
import { createAgent } from "../../../src/agent/agents";
import {
  APEX_DEFAULTS,
  ApexOptions,
  parseApexOptions,
} from "../../../src/agent/agents/apex/options";
import {
  ApexPolicy,
  CONTROLLER_FLAGS,
  usesLookahead,
} from "../../../src/agent/agents/apex/policy";
import { createState } from "../../../src/agent/agents/apex/state";

const APEX_DIR = path.join(__dirname, "../../../src/agent/agents/apex");

describe("apex options", () => {
  test("the defaults parse to themselves, and createAgent reports them", () => {
    expect(parseApexOptions()).toEqual(APEX_DEFAULTS);
    expect(parseApexOptions({})).toEqual(APEX_DEFAULTS);
    const agent = createAgent("apex");
    expect(agent.name).toBe("apex");
    expect(agent.options).toEqual(APEX_DEFAULTS);
  });

  test("every option has a default, and the defaults survive JSON", () => {
    for (const [key, value] of Object.entries(APEX_DEFAULTS)) {
      expect(value, key).not.toBeUndefined();
    }
    // Arena results record the options as JSON.
    expect(JSON.parse(JSON.stringify(APEX_DEFAULTS))).toEqual(APEX_DEFAULTS);
  });

  test("every option is declared and documented in ApexOptions", () => {
    const src = fs.readFileSync(path.join(APEX_DIR, "options.ts"), "utf8");
    const start = src.indexOf("export interface ApexOptions");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const declared = [...body.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
    expect([...declared].sort()).toEqual(Object.keys(APEX_DEFAULTS).sort());
    for (const key of declared) {
      expect(body, `${key} has no doc comment`).toMatch(
        new RegExp(`\\*/\\n {2}${key}:`),
      );
    }
  });

  test("parsing copies: an agent's options never share the defaults", () => {
    const o = parseApexOptions();
    o.spawnGrowth[0] = 1;
    o.classCapsPerMinute.tn = 1;
    o.strikeWindows.push("W1");
    expect(APEX_DEFAULTS.spawnGrowth[0]).toBe(52);
    expect(APEX_DEFAULTS.classCapsPerMinute.tn).toBe(30);
    expect(APEX_DEFAULTS.strikeWindows).toEqual([]);
    const agent = createAgent("apex");
    (agent.options!.spawnGrowth as number[])[0] = 7;
    expect(agent.options!.spawnGrowth).toEqual(APEX_DEFAULTS.spawnGrowth);
  });

  test("createAgent refuses unknown options and accepts known ones", () => {
    expect(() => createAgent("apex", { homeXX: 0.3 })).toThrow(
      /apex has no option "homeXX"/,
    );
    expect(() => parseApexOptions({ homeXX: 0.3 })).toThrow(
      /apex has no option "homeXX"/,
    );
    const agent = createAgent("apex", { homeX: 0.25, recall: false });
    expect(agent.options).toEqual({
      ...APEX_DEFAULTS,
      homeX: 0.25,
      recall: false,
    });
  });

  test.each<[string, unknown]>([
    ["homeX", "0.3"],
    ["thinkEvery", null],
    ["recall", "yes"],
    ["spawnMode", "best"],
    ["structurePolicy", "sometimes"],
    ["webRank", "random"],
    ["spawnGrowth", [52, 3000]],
    ["spawnGrowth", [52, 3000, 10000, 22000, 40000, "90000"]],
    ["strikeWindows", ["W4"]],
    ["strikeWindows", "W1"],
    ["classCapsPerMinute", { chat: 5 }],
    ["classCapsPerMinute", { tn: "20" }],
    ["classCapsPerMinute", [30]],
    ["allyReachCells", "5"],
  ])("refuses %s = %j", (key, value) => {
    expect(() => parseApexOptions({ [key]: value })).toThrow(key);
  });

  test("refuses numbers JSON cannot carry", () => {
    expect(() => parseApexOptions({ homeX: Infinity })).toThrow("homeX");
    expect(() => parseApexOptions({ homeX: NaN })).toThrow("homeX");
  });

  test("merges class caps, dedupes windows, and allows a null reach", () => {
    const o = parseApexOptions({
      classCapsPerMinute: { tn: 20 },
      strikeWindows: ["W1", "W3", "W1"],
      allyReachCells: 5,
    });
    expect(o.classCapsPerMinute).toEqual({
      ...APEX_DEFAULTS.classCapsPerMinute,
      tn: 20,
    });
    expect(o.strikeWindows).toEqual(["W1", "W3"]);
    expect(o.allyReachCells).toBe(5);
    expect(parseApexOptions({ allyReachCells: null }).allyReachCells).toBe(
      null,
    );
  });

  test("defaults follow the M2 build order", () => {
    // Steps 1-7 (spec §4) on.
    const on: (keyof ApexOptions)[] = [
      "tn",
      "snacks",
      "topUps",
      "tribes",
      "stall",
      "stallTribes",
      "stallBoats",
      "headroom",
      "web",
      "foodList",
      "counterAccept",
      "extensions",
      "recall",
      "embargoStop",
      "cancelTnOnThreat",
      "cities",
      "cityUpgradeFirst",
      "boats",
      "contest",
      "buffer",
      "snipes",
      "pokes",
    ];
    for (const key of on) expect(APEX_DEFAULTS[key], key).toBe(true);
    expect(APEX_DEFAULTS.spawnMode).toBe("race");
    // Step 4 of the build uses "free" until NukeModel exists (M3).
    expect(APEX_DEFAULTS.structurePolicy).toBe("free");
    // Step 8 (rollout spawn), step 9 (stall strike) and M3-M5 off.
    const off: (keyof ApexOptions)[] = [
      "stallStrike",
      "strikeFork",
      "allyOracle",
      "defenseSearch",
      "softFloor",
      "deleteCaptured",
      "steering",
      "bombs",
      "mirvGate",
    ];
    for (const key of off) expect(APEX_DEFAULTS[key], key).toBe(false);
    expect(APEX_DEFAULTS.strikeWindows).toEqual([]);
    // So the default agent never forks after the spawn search.
    expect(usesLookahead(APEX_DEFAULTS)).toBe(false);
  });
});

describe("apex controllers", () => {
  test("every controller but Spawn has a boolean enable flag", () => {
    const files = fs
      .readdirSync(path.join(APEX_DIR, "controllers"))
      .filter((f) => f.endsWith("Controller.ts"))
      .map((f) => f.slice(0, -"Controller.ts".length).toLowerCase());
    expect(files.sort()).toEqual(
      ["spawn", ...Object.keys(CONTROLLER_FLAGS)].sort(),
    );
    for (const flag of Object.values(CONTROLLER_FLAGS)) {
      expect(typeof APEX_DEFAULTS[flag], flag).toBe("boolean");
      expect(APEX_DEFAULTS[flag], flag).toBe(true);
    }
  });

  test("a disabled controller does not run", () => {
    const all = new ApexPolicy(parseApexOptions(), createState());
    expect(all.activeControllers()).toEqual([
      "spawn",
      "endgame",
      "strike",
      "expansion",
      "naval",
      "economy",
      "diplomacy",
      "defense",
    ]);
    for (const [name, flag] of Object.entries(CONTROLLER_FLAGS)) {
      const policy = new ApexPolicy(
        parseApexOptions({ [flag]: false }),
        createState(),
      );
      expect(policy.activeControllers()).not.toContain(name);
      expect(policy.activeControllers()).toHaveLength(7);
    }
  });
});
