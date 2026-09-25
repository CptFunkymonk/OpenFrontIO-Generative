import zlib from "zlib";
import { Game, PlayerType } from "../../core/game/Game";
import { simpleHash } from "../../core/Util";

/** Encodes 8-bit RGB pixels as a PNG. No dependencies beyond node:zlib. */
export function encodePng(
  width: number,
  height: number,
  rgb: Uint8Array,
): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const WATER: [number, number, number] = [28, 44, 72];
const LAND: [number, number, number] = [120, 116, 100];
const IMPASSABLE: [number, number, number] = [52, 50, 46];
const FALLOUT: [number, number, number] = [90, 110, 40];
const HIGHLIGHT: [number, number, number] = [255, 40, 200];
const BOT: [number, number, number] = [160, 150, 130];

/**
 * Renders territory: agents (the given smallIDs) in magenta, nations in
 * stable hashed colours, bots in pale grey, unowned land in taupe. Downscaled
 * to at most `maxWidth` pixels wide.
 */
export function renderTerritory(
  game: Game,
  highlightSmallIDs: ReadonlySet<number>,
  maxWidth = 1000,
): Buffer {
  const scale = Math.max(1, Math.ceil(game.width() / maxWidth));
  const w = Math.floor(game.width() / scale);
  const h = Math.floor(game.height() / scale);
  const colours = new Map<number, [number, number, number]>();
  for (const p of game.allPlayers()) {
    let c: [number, number, number];
    if (highlightSmallIDs.has(p.smallID())) c = HIGHLIGHT;
    else if (p.type() === PlayerType.Bot) c = BOT;
    else {
      const hash = simpleHash(p.id());
      c = [
        60 + (hash & 0x7f),
        60 + ((hash >> 7) & 0x7f),
        60 + ((hash >> 14) & 0x7f),
      ];
    }
    colours.set(p.smallID(), c);
  }
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = game.ref(x * scale, y * scale);
      let c = WATER;
      if (game.isLand(t)) {
        const owner = game.ownerID(t);
        c =
          owner !== 0
            ? (colours.get(owner) ?? LAND)
            : game.isImpassable(t)
              ? IMPASSABLE
              : game.hasFallout(t)
                ? FALLOUT
                : LAND;
      }
      const i = (y * w + x) * 3;
      rgb[i] = c[0];
      rgb[i + 1] = c[1];
      rgb[i + 2] = c[2];
    }
  }
  return encodePng(w, h, rgb);
}
