import { spawn } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { ControlPlaneConfig } from "./config.ts"
import type { EventHub } from "./event-hub.ts"
import {
  InMemoryStore,
  type AgentInstance,
  type ChangeReviewFile,
  type ChangeReviewRecord,
  type ChangeReviewRow,
} from "./store.ts"

const MAX_FILES = 30
const MAX_FILE_BYTES = 1_000_000
const MAX_DIFF_BYTES = 2_000_000

export interface DiffComparisonInput {
  beforePath: string
  afterPath: string
  label?: string
}

export type DiffReviewResult =
  | { result: "ok"; reviewId: string }
  | { result: "rejected"; reviewId: string; reason?: string }

function normalizedPath(path: string): string {
  return path.split(sep).join("/")
}

function alignDiffRows(hunks: string[]): ChangeReviewRow[] {
  const rows: ChangeReviewRow[] = []
  let beforeLine = 0
  let afterLine = 0
  let index = 0
  while (index < hunks.length) {
    const line = hunks[index] ?? ""
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (header !== null) {
      beforeLine = Number(header[1])
      afterLine = Number(header[2])
      index += 1
      continue
    }
    if (line.startsWith(" ")) {
      rows.push({ kind: "context", beforeLine, afterLine, beforeText: line.slice(1), afterText: line.slice(1) })
      beforeLine += 1
      afterLine += 1
      index += 1
      continue
    }
    if (line.startsWith("-")) {
      const removed: Array<{ line: number; text: string }> = []
      const added: Array<{ line: number; text: string }> = []
      while (index < hunks.length && hunks[index]?.startsWith("-")) {
        removed.push({ line: beforeLine, text: (hunks[index] ?? "").slice(1) })
        beforeLine += 1
        index += 1
      }
      while (index < hunks.length && hunks[index]?.startsWith("+")) {
        added.push({ line: afterLine, text: (hunks[index] ?? "").slice(1) })
        afterLine += 1
        index += 1
      }
      for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1) {
        const before = removed[offset]
        const after = added[offset]
        rows.push({
          kind: before !== undefined && after !== undefined ? "modified" : before !== undefined ? "deleted" : "added",
          beforeLine: before?.line,
          afterLine: after?.line,
          beforeText: before?.text,
          afterText: after?.text,
        })
      }
      continue
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "added", afterLine, afterText: line.slice(1) })
      afterLine += 1
    }
    index += 1
  }
  return rows
}

async function fileDiff(input: {
  path: string
  beforePath: string
  afterPath: string
  before: string
  after: string
}): Promise<ChangeReviewFile> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-diff-review-"))
  const beforeFile = join(directory, "before")
  const afterFile = join(directory, "after")
  try {
    await Promise.all([writeFile(beforeFile, input.before, "utf8"), writeFile(afterFile, input.after, "utf8")])
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn("git", ["diff", "--no-index", "--no-color", "--unified=3", "--", beforeFile, afterFile])
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
        if (Buffer.byteLength(stdout) > MAX_DIFF_BYTES) child.kill()
      })
      child.stderr.on("data", (chunk: string) => { stderr += chunk })
      child.on("error", reject)
      child.on("close", (code, signal) => {
        if (signal !== null || Buffer.byteLength(stdout) > MAX_DIFF_BYTES) {
          reject(new Error("DIFF_REVIEW_TOO_LARGE"))
          return
        }
        if (code !== 0 && code !== 1) {
          reject(new Error(`DIFF_REVIEW_FAILED: ${stderr.trim() || `git exited ${code}`}`))
          return
        }
        resolveOutput(stdout)
      })
    })
    const lines = output.replaceAll("\r\n", "\n").split("\n")
    const hunkIndex = lines.findIndex((line) => line.startsWith("@@"))
    const hunks = hunkIndex === -1 ? [] : lines.slice(hunkIndex)
    const additions = hunks.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length
    const deletions = hunks.filter((line) => line.startsWith("-") && !line.startsWith("---")).length
    const displayPath = normalizedPath(input.path)
    const beforePath = normalizedPath(input.beforePath)
    const afterPath = normalizedPath(input.afterPath)
    return {
      path: displayPath,
      beforePath,
      afterPath,
      additions,
      deletions,
      rows: alignDiffRows(hunks),
      diff: [
        `diff --git a/${beforePath} b/${afterPath}`,
        `--- a/${beforePath}`,
        `+++ b/${afterPath}`,
        ...hunks,
      ].join("\n").trimEnd(),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export class ChangeReviewManager {
  private readonly waiters = new Map<string, (result: DiffReviewResult) => void>()
  private readonly store: InMemoryStore
  private readonly events: EventHub
  private readonly config: ControlPlaneConfig

  constructor(
    store: InMemoryStore,
    events: EventHub,
    config: ControlPlaneConfig,
  ) {
    this.store = store
    this.events = events
    this.config = config
  }

  async review(input: {
    callerSessionId: string
    summary: string
    comparisons: DiffComparisonInput[]
  }): Promise<DiffReviewResult> {
    const agent = this.requireProjectAgent(input.callerSessionId)
    if (input.comparisons.length === 0 || input.comparisons.length > MAX_FILES) {
      throw new Error("INVALID_DIFF_REVIEW_FILES")
    }
    const files: ChangeReviewFile[] = []
    for (const comparison of input.comparisons) {
      const beforePath = this.safeRelativePath(comparison.beforePath)
      const afterPath = this.safeRelativePath(comparison.afterPath)
      const [before, after] = await Promise.all([
        this.readWorkspaceFile(beforePath),
        this.readWorkspaceFile(afterPath),
      ])
      const diff = await fileDiff({
        path: comparison.label?.trim() || afterPath,
        beforePath,
        afterPath,
        before,
        after,
      })
      if (diff.diff !== "") files.push(diff)
    }
    if (files.length === 0) throw new Error("DIFF_REVIEW_HAS_NO_CHANGES")

    const review = this.store.createChangeReview({ agent, summary: input.summary, files })
    this.store.appendAudit({
      type: "diff_review.requested",
      taskGroupId: agent.taskGroupId,
      agentId: agent.id,
      data: { reviewId: review.id, files: review.files.map((file) => file.path) },
    })

    const decision = new Promise<DiffReviewResult>((resolveDecision) => {
      this.waiters.set(review.id, resolveDecision)
    })
    this.events.publish("diff_review.requested", review)
    return decision.finally(() => this.waiters.delete(review.id))
  }

  list(taskGroupId?: string): ChangeReviewRecord[] {
    return this.store.listChangeReviews({ taskGroupId })
  }

  decide(input: { reviewId: string; decision: "approve" | "reject"; rationale?: string }): ChangeReviewRecord {
    const current = this.store.getChangeReview(input.reviewId)
    if (current === undefined) throw new Error("CHANGE_REVIEW_NOT_FOUND")
    const review = this.store.decideChangeReview({ id: input.reviewId, decision: input.decision, rationale: input.rationale })
    if (review === undefined) throw new Error("CHANGE_REVIEW_NOT_FOUND")
    if (current.status !== "PENDING") return review

    this.store.appendAudit({
      type: `diff_review.${input.decision === "approve" ? "approved" : "rejected"}`,
      taskGroupId: review.taskGroupId,
      agentId: review.agentId,
      data: { reviewId: review.id, rationale: input.rationale },
    })
    this.waiters.get(review.id)?.(
      input.decision === "approve"
        ? { result: "ok", reviewId: review.id }
        : { result: "rejected", reviewId: review.id, reason: input.rationale },
    )
    this.events.publish("diff_review.resolved", review)
    return review
  }

  private requireProjectAgent(sessionId: string): AgentInstance {
    const agent = this.store.getAgentBySession(sessionId)
    if (agent === undefined || agent.role === "APPROVER") throw new Error("CALLER_IS_NOT_PROJECT_AGENT")
    return agent
  }

  private safeRelativePath(path: string): string {
    if (isAbsolute(path)) throw new Error("DIFF_REVIEW_PATH_MUST_BE_RELATIVE")
    const root = resolve(this.config.opencodeDirectory)
    const absolute = resolve(root, path)
    const scoped = relative(root, absolute)
    if (scoped === "" || scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
      throw new Error("DIFF_REVIEW_PATH_OUTSIDE_WORKSPACE")
    }
    return normalizedPath(scoped)
  }

  private async readWorkspaceFile(path: string): Promise<string> {
    const root = await realpath(resolve(this.config.opencodeDirectory))
    const absolute = resolve(root, path)
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error("DIFF_REVIEW_PATH_NOT_FILE")
    if (info.size > MAX_FILE_BYTES) throw new Error("DIFF_REVIEW_FILE_TOO_LARGE")
    const actual = await realpath(absolute)
    const actualRelative = relative(root, actual)
    if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) {
      throw new Error("DIFF_REVIEW_PATH_OUTSIDE_WORKSPACE")
    }
    const content = await readFile(actual, "utf8")
    if (content.includes("\0")) throw new Error("DIFF_REVIEW_BINARY_FILE_UNSUPPORTED")
    return content
  }
}
