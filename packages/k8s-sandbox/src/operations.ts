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
    // `env` (Pi's optional per-command env) is intentionally dropped: kubectl exec
    // has no per-invocation env injection. Pod env is fixed at creation. (M3 TODO.)
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const r = await exec(`cd ${q(cwd)} && ${command}`, { onData, signal, timeout });
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
    // NOTE: matches basenames via `find -name`; does not honour .gitignore or the
    // `ignore` list (a known M2 simplification vs Pi's local `fd`). Returns paths
    // relative to the search cwd (leading "./" stripped).
    glob: async (pattern, cwd, { limit }) => {
      const r = await exec(`cd ${q(cwd)} && find . -type f -name ${shQuote(pattern)} 2>/dev/null | head -n ${limit}`);
      return r.stdout
        .toString()
        .split("\n")
        .filter((x) => x.length > 0)
        .map((rel) => rel.replace(/^\.\//, ""));
    },
  };
}
