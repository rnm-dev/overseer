import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { settings } from "./settings/index.js";

// The one-time pairing secret that bootstraps recruitment (see PROTOCOL.md
// "Recruitment"). Recruitment is chicken-and-egg: the overseer wants to hand a
// fresh peon a `pn_…` credential through POST /api/v1/enroll, but that endpoint
// needs auth and a never-recruited peon holds no overseer credential yet. The
// pairing phrase breaks the cycle — a short-lived, human-carried, single-use
// bootstrap key. Because it's carried by a human, it's a memorable orcish phrase
// (lok-tar-ogar-dabu) rather than random hex.
//
// Security model — memorable is safe here because the phrase is *single-use*,
// *TTL'd* (~15 min), *tailnet-only*, *rate-limited* (agentApi.ts), and compared
// in *constant time*. Entropy is log2(N) * words; the list below is >256 words,
// so a 4-word phrase is ~32 bits — plenty for a secret with all those guards.

// >256 orcish words so a 4-word phrase clears ~32 bits of entropy. Flavour only —
// authenticity isn't the point, memorability + a big enough space is.
export const ORC_WORDS = [
  "lok", "tar", "ogar", "zug", "dabu", "throm", "ka", "grom", "mash", "kaz",
  "mogu", "gul", "dan", "kek", "mag", "har", "thok", "gor", "nal", "rok",
  "zog", "kron", "thrall", "garrosh", "grommash", "durotan", "orgrim", "blackhand",
  "nerzhul", "drek", "thar", "mok", "nathal", "magor", "swobu", "gazlowe",
  "hellscream", "warsong", "frostwolf", "blackrock", "dragonmaw", "thundermaw",
  "burningblade", "maghar", "fel", "warchief", "peon", "grunt", "raider",
  "wolfrider", "headhunter", "doomhammer", "gorehowl", "shadowmoon", "bladefist",
  "kodo", "wyvern", "ripper", "skullsplitter", "bonechewer", "ragefire",
  "grimtotem", "boulderfist", "aka", "magosh", "saurfang", "eitrigg", "nazgrel",
  "rehgar", "draka", "aggra", "geyah", "greatmother", "kilrogg", "deadeye",
  "kargath", "bladefury", "rend", "maim", "cho", "gall", "zaela", "krenna",
  "gorka", "durotar", "orgrimmar", "nagrand", "gorgrond", "tanaan", "hellfire",
  "ashran", "shattrath", "garadar", "razorfen", "hammerfall", "razorhill",
  "splinter", "stonemaul", "laughingskull", "whiteclaw", "thunderlord",
  "shatteredhand", "bleedinghollow", "redwalker", "warmaul", "warbringer",
  "chieftain", "farseer", "blademaster", "berserker", "reaver", "marauder",
  "brute", "savage", "deathdealer", "skullcrusher", "mauler", "slayer", "breaker",
  "cleaver", "basher", "smasher", "gorer", "biter", "render", "shaman", "warlock",
  "axe", "blade", "tusk", "fang", "spike", "chain", "hammer", "maul", "cleave",
  "gore", "howl", "roar", "crush", "smash", "break", "bash", "char", "burn",
  "blood", "bone", "skull", "war", "rage", "fury", "wrath", "doom", "dread",
  "grim", "dark", "black", "red", "iron", "stone", "storm", "thunder", "frost",
  "ember", "ash", "cinder", "molten", "brutal", "feral", "vile", "fierce",
  "mighty", "wolf", "boar", "raptor", "worg", "clefthoof", "talbuk", "ogre",
  "troll", "goblin", "drake", "wyrm", "gronn", "magnaron", "ogron", "botani",
  "saberon", "uruk", "snaga", "ghash", "sharku", "nazgul", "mordor", "gorbag",
  "shagrat", "grishnakh", "mauhur", "ugluk", "muzgash", "lagduf", "radbug",
  "golfimbul", "azog", "bolg", "gorkil", "yazneg", "narzug", "fimbul", "grinnah",
  "bhakh", "morg", "grok", "throg", "brok", "zaguk", "gruk", "nar", "drak",
  "gash", "mush", "gruul", "grull", "thak", "zagh", "kagh", "ruk", "nuk",
  "thodok", "dogar", "morkh", "zurak", "vrak", "khaz", "dregar", "moknathal",
  "gorok", "thokk", "grimtusk", "bloodfang", "ironjaw", "stonefist", "skullreaver",
  "warhowl", "ragetusk", "doomaxe", "blackfang", "felscar", "gorewind", "bonesnap",
  "dreadmaul", "grimjaw", "ashfang", "emberfist", "frostfang", "thunderfist",
  "stormfang", "direfang", "savagemaw", "warfang", "bloodmaw", "ironhide",
  "stonehide", "grimhide",
];

export function orcishPhrase(words = 4): string {
  return Array.from({ length: words }, () => ORC_WORDS[randomInt(ORC_WORDS.length)]).join("-");
}

// So a human can type the phrase forgivingly: "Lok Tar  Ogar_Dabu" and
// "lok-tar-ogar-dabu" both normalize to the same canonical form.
export function normalizePhrase(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

export function phraseMatches(candidate: string, stored: string): boolean {
  const a = createHash("sha256").update(normalizePhrase(candidate)).digest();
  const b = createHash("sha256").update(normalizePhrase(stored)).digest();
  return timingSafeEqual(a, b); // equal-length hashes → constant-time
}

// Lifecycle over settings.pairingSecret / .pairingSecretExpiresAt:
//   arm()   — generate + persist a fresh phrase and open a TTL'd window.
//   check() — is a candidate the armed, unexpired phrase?
//   burn()  — clear it (single-use: called after a successful /enroll).
export const pairing = {
  arm(): { phrase: string; expiresAt: number } {
    const phrase = orcishPhrase();
    const expiresAt = Date.now() + Math.max(1_000, settings.get().pairingTtlMs);
    settings.update({ pairingSecret: phrase, pairingSecretExpiresAt: expiresAt });
    return { phrase, expiresAt };
  },

  isArmed(): boolean {
    const s = settings.get();
    return Boolean(s.pairingSecret) && s.pairingSecretExpiresAt > Date.now();
  },

  check(candidate: string): boolean {
    const s = settings.get();
    if (!candidate || !s.pairingSecret || s.pairingSecretExpiresAt <= Date.now()) return false;
    return phraseMatches(candidate, s.pairingSecret);
  },

  burn(): void {
    settings.update({ pairingSecret: "", pairingSecretExpiresAt: 0 });
  },
};
