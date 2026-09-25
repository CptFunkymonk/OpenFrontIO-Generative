import { ArenaGameSpec, runArenaGame } from "./ArenaGame";

/**
 * Child-process entry for the arena: runs exactly one game per process, so
 * a crash or a leak can only ever cost that one game. Started by Arena.ts
 * with `fork(..., { execArgv: ["--import", "tsx"] })`.
 */
export interface ArenaWorkerRequest {
  spec: ArenaGameSpec;
  mapsDir: string;
  verbose: boolean;
}

process.once("message", (req: ArenaWorkerRequest) => {
  if (!req.verbose) {
    // The simulation logs per tick; nations log every refused build.
    console.debug = () => {};
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
  }
  runArenaGame(req.spec, req.mapsDir)
    .then((result) => process.send!({ result }, () => process.exit(0)))
    .catch((e: unknown) => {
      process.send!(
        { crash: e instanceof Error ? (e.stack ?? e.message) : String(e) },
        () => process.exit(1),
      );
    });
});
