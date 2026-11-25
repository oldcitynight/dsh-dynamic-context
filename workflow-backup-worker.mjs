// SPDX-License-Identifier: GPL-3.0-only
import { parentPort, workerData } from 'node:worker_threads'
import { WorkflowDatabase, sqliteLockContention } from './workflow-database.mjs'
import { backupWorkflow } from './workflow-backup.mjs'
let db
try {
  db = new WorkflowDatabase(workerData.directory, workerData.binding)
  if (!workerData.closing) db.db.exec('PRAGMA busy_timeout=100')
  parentPort.postMessage({ result: backupWorkflow(db) })
} catch (error) {
  parentPort.postMessage({ error: sqliteLockContention(error) ? 'WORKFLOW_BACKUP_CHECKPOINT_BUSY' : error.code ?? 'WORKFLOW_BACKUP_FAILED',
    message: error.message })
} finally {
  db?.close()
}
