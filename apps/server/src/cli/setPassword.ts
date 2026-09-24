import { initDb } from "../infrastructure/db/index.js";
import { MIN_PASSWORD_LENGTH, resetPasswordByEmail } from "../modules/auth/index.js";

// Replace an account's password from the server's shell:
//
//   docker compose exec app node dist/cli/setPassword.js user@example.com
//
// Asks for the new password twice without echoing it. Piped input is read as
// the password instead, for scripts: `printf '%s' "$PW" | ... setPassword.js`.
// The password never goes on the command line, where `ps` and shell history
// would keep it. Every signed-in device of the account is signed out.

const USAGE = "usage: node dist/cli/setPassword.js <email>";

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

// Raw mode rather than readline, so nothing typed reaches the terminal.
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (input: string) => {
      for (const ch of input) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readPiped();
  const first = await promptHidden(`New password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  const second = await promptHidden("Repeat it: ");
  if (first !== second) throw new Error("the two passwords do not match");
  return first;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.error(USAGE);
    return 2;
  }
  const password = await readPassword();
  await initDb();
  const { user, revokedDevices } = await resetPasswordByEmail({ email: args[0], password });
  console.log(`Password set for ${user.email}; signed out ${revokedDevices} device(s).`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`set-password: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
