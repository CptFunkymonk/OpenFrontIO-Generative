// Watch an AI agent play the real client: starts a singleplayer game with the
// autopilot on (?agent=<name>, see src/client/AgentAutopilot.ts), never
// touches the mouse, and records what the agent's player does. The agent runs
// in its own Web Worker; this script only observes.
//
//   node .claude/skills/run-openfront/autopilot.mjs [agent] [map] [seconds]
//   node .claude/skills/run-openfront/autopilot.mjs baseline Iceland 90
//
// Dev server must be up (npm run dev). Screenshots and a JSON trace go to
// /tmp/openfront-run/autopilot-*.
import fs from "fs";
import { launch, openSoloModal } from "./driver.mjs";
import { gameState, startSoloGame } from "./game.mjs";

const [agent = "baseline", map = "Iceland", seconds = "90"] =
  process.argv.slice(2);
const outDir = "/tmp/openfront-run";
fs.mkdirSync(outDir, { recursive: true });

const { browser, page } = await launch({ rafIntervalMs: 3000 });
const agentLines = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (text.startsWith("[agent]")) {
    agentLines.push(text);
    console.log(text);
  }
});

await page.goto(`http://localhost:9000/?agent=${encodeURIComponent(agent)}`, {
  waitUntil: "load",
  timeout: 60000,
});
await page.waitForTimeout(3000);
await openSoloModal(page);
await startSoloGame(page, { map, difficulty: "Impossible", bots: 100 });
console.log(`game started on ${map}; hands off, the agent plays`);

const trace = [];
const deadline = Date.now() + Number(seconds) * 1000;
let shot = 0;
while (Date.now() < deadline) {
  await page.waitForTimeout(10000);
  const s = await gameState(page);
  trace.push(s);
  console.log(
    `tick ${s.ticks} spawnPhase=${s.inSpawnPhase} ` +
      `tiles=${s.myPlayer?.tilesOwned} troops=${Math.round(s.myPlayer?.troops ?? 0)} ` +
      `gold=${s.myPlayer?.gold} alive=${s.myPlayer?.isAlive}`,
  );
  await page.screenshot({ path: `${outDir}/autopilot-${shot++}.png` });
}
fs.writeFileSync(
  `${outDir}/autopilot-trace.json`,
  JSON.stringify({ agent, map, trace, agentLines }, null, 1),
);
await browser.close();

const last = trace[trace.length - 1];
const ok =
  last?.myPlayer?.tilesOwned > 0 &&
  agentLines.some((l) => l.includes("spawn at"));
console.log(ok ? "AUTOPILOT OK" : "AUTOPILOT FAILED: the agent did not play");
process.exit(ok ? 0 : 1);
