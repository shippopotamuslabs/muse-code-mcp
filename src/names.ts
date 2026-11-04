import { randomInt } from "node:crypto";

/**
 * Server-minted canonical session names (MFST-61/S4). The serve host
 * never allocates a name for MSP-started sessions, so the server mints
 * one in the TUI allocate style — lowercase word-word, e.g. `brook-io`.
 * Plain data in, plain data out: no MCP or MSP types here.
 */
const NAME_FIRST_WORDS = [
  "amber",
  "amethyst",
  "ash",
  "aspen",
  "aurora",
  "basalt",
  "bay",
  "birch",
  "brook",
  "cedar",
  "citrine",
  "cliff",
  "clover",
  "cobalt",
  "comet",
  "cove",
  "crag",
  "cypress",
  "dawn",
  "drift",
  "dune",
  "ember",
  "fern",
  "flint",
  "garnet",
  "glade",
  "granite",
  "grove",
  "harbor",
  "hazel",
  "heath",
  "holly",
  "inlet",
  "iris",
  "ivory",
  "jasper",
  "juniper",
  "kelp",
  "lagoon",
  "larch",
  "lilac",
  "lotus",
  "maple",
  "marble",
  "meadow",
  "moss",
  "onyx",
  "opal",
];

const NAME_SECOND_WORDS = [
  "acrux",
  "adhara",
  "albireo",
  "algol",
  "alioth",
  "altair",
  "antares",
  "arcturus",
  "atlas",
  "bellatrix",
  "canopus",
  "capella",
  "castor",
  "ceti",
  "crux",
  "cygnus",
  "deneb",
  "dione",
  "dubhe",
  "electra",
  "enceladus",
  "europa",
  "ganymede",
  "hydra",
  "io",
  "lyra",
  "maia",
  "merope",
  "mira",
  "mizar",
  "nova",
  "oberon",
  "orion",
  "phoebe",
  "polaris",
  "pollux",
  "procyon",
  "regulus",
  "rhea",
  "rigel",
  "sirius",
  "spica",
  "titan",
  "vega",
];

/** Attempts to find a name the store does not already carry. */
const MINT_ATTEMPTS = 8;

function pick(words: readonly string[]): string {
  return words[randomInt(words.length)] ?? words[0] ?? "unnamed";
}

/**
 * Mint a canonical name not present in `taken`. Re-mints a bounded
 * number of times on collision; the last candidate wins when every
 * attempt collides, so the caller never loops forever.
 */
export function mintSessionName(taken: ReadonlySet<string>): string {
  let candidate = `${pick(NAME_FIRST_WORDS)}-${pick(NAME_SECOND_WORDS)}`;
  for (let attempt = 1; attempt < MINT_ATTEMPTS && taken.has(candidate); attempt += 1) {
    candidate = `${pick(NAME_FIRST_WORDS)}-${pick(NAME_SECOND_WORDS)}`;
  }
  return candidate;
}
