import { execFile } from "child_process";
import * as path from "path";

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  subject: string;
}

export interface Ref {
  name: string;
  type: "head" | "remote" | "tag";
  hash: string;
}

export interface Stash {
  selector: string;
  hash: string;
  date: number;
  message: string;
}

export interface FileChange {
  status: string;
  path: string;
  oldPath?: string;
}

export interface WorkingChange extends FileChange {
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
}

export interface BranchComparison {
  base: string;
  target: string;
  files: FileChange[];
}

export interface CommitDetail {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  committer: string;
  commitDate: number;
  subject: string;
  body: string;
  files: FileChange[];
}

const FS = "\x1f";
const RS = "\x1e";
export const HASH_RE = /^[0-9a-f]{7,64}$/;

export class Git {
  constructor(readonly root: string) {}

  static async findRoot(dir: string): Promise<string | undefined> {
    try {
      return path.resolve(
        (await exec(dir, ["rev-parse", "--show-toplevel"])).trim(),
      );
    } catch {
      return undefined;
    }
  }

  run(args: string[]): Promise<string> {
    return exec(this.root, args);
  }

  async log(limit: number): Promise<{ commits: Commit[]; hasMore: boolean }> {
    const hasCommits = await this.run([
      "rev-parse",
      "-q",
      "--verify",
      "HEAD",
    ]).then(
      () => true,
      () => false,
    );
    if (!hasCommits) return { commits: [], hasMore: false };

    const out = await this.run([
      "log",
      "--exclude=refs/stash",
      "--all",
      "--date-order",
      `--max-count=${limit + 1}`,
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e",
    ]);
    const commits = out
      .split(RS)
      .map((r) => r.replace(/^\n/, ""))
      .filter(Boolean)
      .map((r) => {
        const [hash, parents, author, email, date, subject] = r.split(FS);
        return {
          hash,
          parents: parents ? parents.split(" ") : [],
          author,
          email,
          date: Number(date),
          subject: subject ?? "",
        };
      });
    return {
      commits: commits.slice(0, limit),
      hasMore: commits.length > limit,
    };
  }

  async refs(): Promise<Ref[]> {
    const out = await this.run([
      "for-each-ref",
      "--format=%(objectname)%1f%(*objectname)%1f%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    const refs: Ref[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [object, peeled, ref] = line.split(FS);
      // Annotated tags point to a tag object; the peeled value is the commit.
      const hash = peeled || object;
      if (ref.startsWith("refs/heads/"))
        refs.push({ type: "head", name: ref.slice(11), hash });
      else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
        refs.push({ type: "remote", name: ref.slice(13), hash });
      else if (ref.startsWith("refs/tags/"))
        refs.push({ type: "tag", name: ref.slice(10), hash });
    }
    return refs;
  }

  async head(): Promise<{ branch: string | null; hash: string | null }> {
    const branch = await this.run([
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]).then(
      (s) => s.trim(),
      () => null,
    );
    const hash = await this.run(["rev-parse", "-q", "--verify", "HEAD"]).then(
      (s) => s.trim(),
      () => null,
    );
    return { branch, hash };
  }

  async stashes(): Promise<Stash[]> {
    const out = await this.run([
      "stash",
      "list",
      "--format=%H%x1f%gd%x1f%at%x1f%gs",
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, selector, date, message] = line.split(FS);
        return { hash, selector, date: Number(date), message };
      });
  }

  async uncommittedCount(): Promise<number> {
    return (await this.workingChanges()).length;
  }

  async workingChanges(): Promise<WorkingChange[]> {
    const parts = (
      await this.run([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    ).split("\0");
    const files: WorkingChange[] = [];
    for (let i = 0; i < parts.length; ) {
      const entry = parts[i++];
      if (!entry) continue;
      const indexStatus = entry[0];
      const worktreeStatus = entry[1];
      const path = entry.slice(3);
      const renamed =
        indexStatus === "R" ||
        indexStatus === "C" ||
        worktreeStatus === "R" ||
        worktreeStatus === "C";
      const oldPath = renamed ? parts[i++] : undefined;
      const status = worktreeStatus !== " " ? worktreeStatus : indexStatus;
      files.push({
        status: status === "?" ? "?" : status,
        path,
        oldPath,
        indexStatus,
        worktreeStatus,
        staged: indexStatus !== " " && indexStatus !== "?",
      });
    }
    return files;
  }

  async branchComparison(ref: string): Promise<BranchComparison> {
    const [base, target] = await Promise.all([
      this.run(["rev-parse", "--verify", "HEAD^{commit}"]).then((value) =>
        value.trim(),
      ),
      this.run(["rev-parse", "--verify", `${ref}^{commit}`]).then((value) =>
        value.trim(),
      ),
    ]);
    return { base, target, files: await this.changes(base, target) };
  }

  async commitAll(message: string): Promise<void> {
    const subject = message.trim();
    if (!subject) throw new Error("Escribe un mensaje para el commit.");
    await this.run(["add", "--all"]);
    await this.run(["commit", "-m", subject]);
  }

  async commitDetail(hash: string): Promise<CommitDetail> {
    const out = await this.run([
      "show",
      "-s",
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1f%b",
      hash,
    ]);
    const [
      h,
      parents,
      author,
      email,
      date,
      committer,
      commitDate,
      subject,
      body,
    ] = out.split(FS);
    const parentList = parents ? parents.split(" ") : [];
    return {
      hash: h,
      parents: parentList,
      author,
      email,
      date: Number(date),
      committer,
      commitDate: Number(commitDate),
      subject,
      body: (body ?? "").trim(),
      files: await this.changes(parentList[0], h),
    };
  }

  async changes(
    parent: string | undefined,
    hash: string,
  ): Promise<FileChange[]> {
    const args = parent
      ? ["diff", "--name-status", "-z", "-M", parent, hash]
      : [
          "diff-tree",
          "--root",
          "-r",
          "--no-commit-id",
          "--name-status",
          "-z",
          "-M",
          hash,
        ];
    const parts = (await this.run(args)).split("\0");
    const files: FileChange[] = [];
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++];
      if (!status) continue;
      const letter = status[0];
      if (letter === "R" || letter === "C")
        files.push({ status: letter, oldPath: parts[i++], path: parts[i++] });
      else files.push({ status: letter, path: parts[i++] });
    }
    return files;
  }

  async isValidRefName(kind: "branch" | "tag", name: string): Promise<boolean> {
    if (!name || name.startsWith("-")) return false;
    const args =
      kind === "branch"
        ? ["check-ref-format", "--branch", name]
        : ["check-ref-format", `refs/tags/${name}`];
    return this.run(args).then(
      () => true,
      () => false,
    );
  }
}

function exec(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "log.showSignature=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      },
    );
  });
}
