// PROTOTYPE — throwaway probe app for exhibit issue #10.
// Plays the deployed webapp: launched by systemd as
// `fnox exec -- mise run production`, it reports its identity, attempts a
// matrix of writes, then stays alive like a real server. It asserts nothing —
// run.sh reads these lines from the journal and judges them against the
// acceptance criteria. Confinement must hold whether or not this app
// cooperates; the probes just make the boundary visible.

import { writeFileSync, appendFileSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import os from "node:os";

const state = process.env.STATE_DIRECTORY ?? "(unset)";
const logs = process.env.LOGS_DIRECTORY ?? "(unset)";
const domain = basename(state);

// --- identity (criteria 3 + 5) ---
console.log(`IDENT uid=${process.getuid!()} gid=${process.getgid!()}`);
let username = "(unresolvable)";
try {
  username = os.userInfo().username;
} catch {}
console.log(`IDENT username=${username}`);
console.log(`IDENT netns=${readlinkSync("/proc/self/ns/net")}`);
console.log(`IDENT cwd=${process.cwd()}`);
console.log(`IDENT state_dir=${state} logs_dir=${logs}`);
// fnox decrypted this from the age-encrypted fnox.toml (fake secret, safe to print)
console.log(`IDENT secret=${process.env.APP_GREETING ?? "(missing)"}`);
// the artifact `mise run prepare` wrote into the release dir pre-cutover
let prepared = "(missing)";
try {
  prepared = readFileSync(".exhibit-prepared", "utf8").trim();
} catch {}
console.log(`IDENT prepared=${prepared}`);

// --- restart persistence (criterion 3): what did the previous run leave? ---
const marker = `${state}/restarts.log`;
let previous = "(none)";
try {
  previous = readFileSync(marker, "utf8").trim().split("\n").at(-1) ?? "(none)";
} catch {}
console.log(`IDENT previous_run=${previous}`);

// --- write probe matrix (criteria 1 + 2) ---
function probe(label: string, path: string, mode: "write" | "append" = "write") {
  try {
    if (mode === "append") appendFileSync(path, `uid=${process.getuid!()} pid=${process.pid}\n`);
    else writeFileSync(path, `written by ${domain} uid=${process.getuid!()}\n`);
    console.log(`PROBE ${label} path=${path} result=OK`);
  } catch (e: any) {
    console.log(`PROBE ${label} path=${path} result=${e.code}`);
  }
}

probe("state", `${state}/probe.txt`);
probe("state-persist", marker, "append");
probe("logs", `${logs}/app.log`, "append");
probe("release", `${process.cwd()}/release-write.txt`);
probe("etc", "/etc/exhibit-intrusion.txt");
probe("usr", "/usr/exhibit-intrusion.txt");
probe("rootfs", "/exhibit-intrusion.txt");
for (const d of (process.env.EXHIBIT_DOMAINS ?? "").split(/\s+/).filter(Boolean)) {
  if (d === domain) continue;
  probe("sibling-state", `/var/lib/exhibit/${d}/intrusion.txt`);
  probe("sibling-logs", `/var/log/exhibit/${d}/intrusion.txt`);
}

// who owns our state files, as seen from inside the sandbox?
// (host sees 65534/nobody — systemd ID-maps the mount; inside must be us)
try {
  console.log(`IDENT state_owner=${statSync(marker).uid}`);
} catch {
  console.log("IDENT state_owner=(stat failed)");
}

console.log("PROBES-DONE");

// now behave like `mise run production`: a long-running server
setInterval(() => {}, 1 << 30);
