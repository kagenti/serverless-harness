import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { K8sSandboxConfig } from "./config.js";
import type { ExecInPod } from "./exec.js";
import { mapPath, shQuote } from "./paths.js";

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function mapper(cfg: K8sSandboxConfig) {
  return (p: string) => shQuote(mapPath(p, cfg.headCwd, cfg.podCwd));
}

export function createPodReadOps(exec: ExecInPod, cfg: K8sSandboxConfig): ReadOperations {
  const q = mapper(cfg);
  return {
    readFile: async (p) => (await exec(`cat ${q(p)}`)).stdout,
    access: async (p) => {
      const r = await exec(`test -r ${q(p)}`);
      if (r.exitCode !== 0) throw new Error(`File not readable in pod: ${p}`);
    },
    detectImageMimeType: async (p) => {
      const r = await exec(`file --mime-type -b ${q(p)}`);
      const mime = r.stdout.toString().trim();
      return IMAGE_MIMES.includes(mime) ? mime : null;
    },
  };
}

export function createPodWriteOps(exec: ExecInPod, cfg: K8sSandboxConfig): WriteOperations {
  const q = mapper(cfg);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString("base64");
      const r = await exec(`base64 -d > ${q(p)}`, { stdin: Buffer.from(b64) });
      if (r.exitCode !== 0) throw new Error(`Write failed in pod: ${p}`);
    },
    mkdir: async (dir) => {
      const r = await exec(`mkdir -p ${q(dir)}`);
      if (r.exitCode !== 0) throw new Error(`mkdir failed in pod: ${dir}`);
    },
  };
}

export function createPodEditOps(exec: ExecInPod, cfg: K8sSandboxConfig): EditOperations {
  const read = createPodReadOps(exec, cfg);
  const write = createPodWriteOps(exec, cfg);
  const q = mapper(cfg);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (p) => {
      const r = await exec(`test -r ${q(p)} && test -w ${q(p)}`);
      if (r.exitCode !== 0) throw new Error(`File not read-writable in pod: ${p}`);
    },
  };
}

export function createPodBashOps(exec: ExecInPod, cfg: K8sSandboxConfig): BashOperations {
  const q = mapper(cfg);
  return {
    // Pi passes `env` only to the bash tool. Inject it here (transport-agnostic)
    // as an `env VAR=val … bash -c <cmd>` prefix: scoped to this one invocation,
    // so nothing leaks across calls (M2 dropped env entirely — see git history).
    // Keys are validated as POSIX names (malformed keys are dropped, never interpolated)
    // so the prefix can't be injected; values remain safe via shQuote.
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const pairs = env
        ? Object.entries(env)
            .filter(([k, v]) => v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
            .map(([k, v]) => `${k}=${shQuote(String(v))}`)
        : [];
      const wrapped = pairs.length
        ? `cd ${q(cwd)} && env ${pairs.join(" ")} bash -c ${shQuote(command)}`
        : `cd ${q(cwd)} && ${command}`; // M2's exact form — unchanged when no env
      const r = await exec(wrapped, { onData, signal, timeout });
      return { exitCode: r.exitCode };
    },
  };
}

export function createPodLsOps(exec: ExecInPod, cfg: K8sSandboxConfig): LsOperations {
  const q = mapper(cfg);
  return {
    exists: async (p) => (await exec(`test -e ${q(p)}`)).exitCode === 0,
    stat: async (p) => {
      const r = await exec(`test -e ${q(p)} && (test -d ${q(p)} && echo DIR || echo FILE)`);
      if (r.exitCode !== 0) throw new Error(`Path not found in pod: ${p}`);
      const isDir = r.stdout.toString().trim() === "DIR";
      return { isDirectory: () => isDir };
    },
    readdir: async (p) => {
      const r = await exec(`ls -1A ${q(p)}`);
      if (r.exitCode !== 0) throw new Error(`readdir failed in pod: ${p}`);
      return r.stdout.toString().split("\n").filter((x) => x.length > 0);
    },
  };
}

export function createPodFindOps(exec: ExecInPod, cfg: K8sSandboxConfig): FindOperations {
  const q = mapper(cfg);
  return {
    exists: async (p) => (await exec(`test -e ${q(p)}`)).exitCode === 0,
    // `rg --files --hidden` lists files under cwd, honouring .gitignore (verified
    // on the pod's ripgrep 14.1.0). Nuance: gitignored DIRECTORIES (e.g. node_modules/,
    // dist/) are pruned and stay excluded even though an explicit -g matches files
    // inside them; but an individually-gitignored FILE matching the positive -g
    // <pattern> IS re-included (the glob whitelist-overrides a file-level ignore) —
    // a minor divergence from Pi's `fd --glob`. Pi's `ignore` list is applied as
    // negated globs (-g '!<ig>') and always excludes its entries. --hidden keeps
    // dotfiles in view. Paths come back relative to cwd; strip any leading "./".
    glob: async (pattern, cwd, { ignore, limit }) => {
      const globs = [`-g ${shQuote(pattern)}`, ...ignore.map((ig) => `-g ${shQuote(`!${ig}`)}`)];
      const r = await exec(`cd ${q(cwd)} && rg --files --hidden ${globs.join(" ")} | head -n ${limit}`);
      return r.stdout
        .toString()
        .split("\n")
        .filter((x) => x.length > 0)
        .map((rel) => rel.replace(/^\.\//, ""));
    },
  };
}
