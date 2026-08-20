import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  InMemoryStore,
  type AgentQuestion,
  type AgentInstance,
  type AuditRecord,
  type ChangeReviewRecord,
  type JobWatchRecord,
  type PermissionRequestRecord,
  type StoreSnapshot,
  type TaskGroup,
  type WorkerTask,
} from "./store.ts"

interface JsonRow {
  data_json: string
}

function parseRows<T>(rows: JsonRow[]): T[] {
  return rows.map((row) => JSON.parse(row.data_json) as T)
}

export class SqliteStore extends InMemoryStore {
  private database: DatabaseSync | undefined
  readonly path: string

  constructor(path: string) {
    super()
    this.path = path
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { timeout: 5_000 })
    this.migrate()
    this.restoreSnapshot(this.loadSnapshot())
  }

  protected override persist(): void {
    const database = this.database
    if (database === undefined) return
    const snapshot = this.snapshot()
    database.exec("BEGIN IMMEDIATE")
    try {
      for (const table of [
        "task_groups",
        "agents",
        "worker_tasks",
        "spawn_requests",
        "permission_requests",
        "audit_records",
        "agent_questions",
        "change_reviews",
        "job_watches",
      ]) {
        database.exec(`DELETE FROM ${table}`)
      }

      this.insertJsonRows("task_groups", snapshot.taskGroups.map((item) => ({ id: item.id, item })))
      this.insertJsonRows("agents", snapshot.agents.map((item) => ({ id: item.id, item })))
      this.insertJsonRows("worker_tasks", snapshot.workerTasks.map((item) => ({ id: item.id, item })))
      this.insertJsonRows(
        "spawn_requests",
        snapshot.spawnRequests.map((item) => ({ id: item.key, item })),
      )
      this.insertJsonRows(
        "permission_requests",
        snapshot.permissionRequests.map((item) => ({ id: item.id, item })),
      )
      this.insertJsonRows("audit_records", snapshot.auditRecords.map((item) => ({ id: item.id, item })))
      this.insertJsonRows("agent_questions", snapshot.agentQuestions.map((item) => ({ id: item.id, item })))
      this.insertJsonRows("change_reviews", (snapshot.changeReviews ?? []).map((item) => ({ id: item.id, item })))
      this.insertJsonRows("job_watches", (snapshot.jobWatches ?? []).map((item) => ({ id: item.id, item })))
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }

  override close(): void {
    if (this.database === undefined) return
    this.persist()
    this.database.close()
    this.database = undefined
  }

  private migrate(): void {
    const database = this.database
    if (database === undefined) return
    database.exec("PRAGMA journal_mode = WAL")
    database.exec("PRAGMA synchronous = NORMAL")
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS task_groups (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS worker_tasks (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spawn_requests (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS permission_requests (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_records (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_questions (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS change_reviews (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS job_watches (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      ) STRICT;
    `)
    database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(1, new Date().toISOString())
    database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(2, new Date().toISOString())
    database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(3, new Date().toISOString())
    database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(4, new Date().toISOString())
  }

  private loadSnapshot(): StoreSnapshot {
    const database = this.database
    if (database === undefined) throw new Error("SQLITE_STORE_CLOSED")
    const read = <T>(table: string): T[] => {
      const statement = database.prepare(`SELECT data_json FROM ${table}`)
      return parseRows<T>(statement.all() as JsonRow[])
    }
    return {
      schemaVersion: 1,
      taskGroups: read<TaskGroup>("task_groups"),
      agents: read<AgentInstance>("agents"),
      workerTasks: read<WorkerTask>("worker_tasks"),
      spawnRequests: read<{ key: string; taskIds: string[] }>("spawn_requests"),
      permissionRequests: read<PermissionRequestRecord>("permission_requests"),
      auditRecords: read<AuditRecord>("audit_records").sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      agentQuestions: read<AgentQuestion>("agent_questions"),
      changeReviews: read<ChangeReviewRecord>("change_reviews"),
      jobWatches: read<JobWatchRecord>("job_watches"),
    }
  }

  private insertJsonRows(table: string, rows: Array<{ id: string; item: unknown }>): void {
    const database = this.database
    if (database === undefined) throw new Error("SQLITE_STORE_CLOSED")
    const statement = database.prepare(`INSERT INTO ${table}(id, data_json) VALUES (?, ?)`)
    for (const row of rows) statement.run(row.id, JSON.stringify(row.item))
  }
}
