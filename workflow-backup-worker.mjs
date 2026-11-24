// SPDX-License-Identifier: GPL-3.0-only
import { parentPort, workerData } from 'node:worker_threads'
import { WorkflowDatabase } from './workflow-database.mjs'
import { backupWorkflow } from './workflow-backup.mjs'
const db = new WorkflowDatabase(workerData.directory, workerData.binding)
try {
  db.db.exec('PRAGMA busy_timeout=100')
  parentPort.postMessage({ result: backupWorkflow(db) })
} catch (error) {
  parentPort.postMessage({ error: error.code ?? 'WORKFLOW_BACKUP_FAILED', message: error.message })
} finally {
  db.close()
}
