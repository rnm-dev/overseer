import { createHash, createPrivateKey, generateKeyPairSync, sign, } from "node:crypto";
import { existsSync, readFileSync, } from "node:fs";
import path from "node:path";
import { configDir } from "../xdgPaths.js";
import { secureExistingPrivateFile, writePrivateFileDurably, } from "../durablePrivateFile.js";
export function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    if (typeof value !== "object")
        throw new Error("value is not JSON-canonicalizable");
    const record = value;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
}
function publicJwk(privateKey) {
    if (privateKey.kty !== "OKP" || privateKey.crv !== "Ed25519" || typeof privateKey.x !== "string") {
        throw new Error("invalid Ed25519 identity key");
    }
    return { kty: "OKP", crv: "Ed25519", x: privateKey.x };
}
export class PeonIdentityStore {
    filePath;
    constructor(filePath = path.join(configDir(), "identity-ed25519-v1.jwk")) {
        this.filePath = filePath;
    }
    ensure(peonId) {
        const stored = existsSync(this.filePath) ? this.read() : this.create(peonId);
        if (stored.peonId !== peonId) {
            throw new Error("Peon identity key belongs to a different peonId");
        }
        const publicKey = publicJwk(stored.privateKey);
        const identityKeyId = `ed25519:${createHash("sha256").update(canonicalJson(publicKey)).digest("base64url")}`;
        const key = createPrivateKey({ key: stored.privateKey, format: "jwk" });
        return {
            peonId,
            identityKeyId,
            publicKey,
            sign: (payload) => sign(null, payload, key).toString("base64url"),
        };
    }
    existingPeonId() {
        return existsSync(this.filePath) ? this.read().peonId : null;
    }
    create(peonId) {
        const { privateKey } = generateKeyPairSync("ed25519");
        const stored = {
            version: 1,
            peonId,
            privateKey: privateKey.export({ format: "jwk" }),
        };
        writePrivateFileDurably(this.filePath, `${JSON.stringify(stored)}\n`);
        return stored;
    }
    read() {
        secureExistingPrivateFile(this.filePath);
        const stored = JSON.parse(readFileSync(this.filePath, "utf8"));
        if (!stored || stored.version !== 1 || typeof stored.peonId !== "string" || !stored.privateKey) {
            throw new Error("invalid Peon identity key file");
        }
        publicJwk(stored.privateKey);
        if (typeof stored.privateKey.d !== "string")
            throw new Error("Peon identity private key is missing");
        return stored;
    }
}
