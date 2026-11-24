# Workflow storage

Prerequisite rule drafts, outstanding confirmation receipts and blueprint audit decisions use the versioned record `planning-rules.json`. On SQLite the revision check and record update share a transaction. The committed task graph carries the canonical rules and execution history. See the [rule authoring guide](PREREQUISITE-RULES.md).

A newly adopted workflow has one SQLite database in its private instance directory. Set `storageFormat` to `auto` (default) or `sqlite` to use this format for new instances. `files` creates a new file-backed instance. An existing file-backed workflow, including an instance with a surviving graph commitment witness, continues to use its original format. The conversation template and standalone task-graph plugin keep their existing storage boundaries.

The instance marker and a small identity record under the configured storage root distinguish an established database from an unused directory. Loss of the database or a mismatched binding stops that instance. A safely interrupted first initialization may be completed on the next mount. Existing session logs, working files, and native DSH attachments remain owned by their original services.

## Workflow release identity

The first entry into a full workflow freezes the two installed package versions and their shared `workflowCompatibilityEpoch`. On SQLite this value lives in `instance.workflow_release`. The first write advances `PRAGMA user_version` to 2 in the same transaction. File-backed workflows keep the same identity in a tagged, directory-bound `.workflow-storage-v1` marker, replaced under the storage lock. Both formats reject downgrades, preserve graph revision numbers during compatible upgrades and prevent pre-epoch readers from opening the frozen graph. Database backups include the release identity.

## Content and checkpoints

The database stores request bodies, role records, both graphs, graph witnesses, reports, planning evidence, tool receipts, compaction archives, private checkpoints, and incrementally appended display output. Identical bytes share a document. The ordered children of messages, tool definitions, system prompts, snapshots and graph structures refer to shared documents and compressed chunks. A graph revision can have multiple supervision commits. They have separate, ordered state-history entries. A display index serves pages by sequence or revision. Immutable original evidence stays available for scoped tools.

Small structural fields share the enclosing document's chunks. Messages, tool lists, system prompts and witnessed graphs remain separately addressable, including inside short requests. A whole document stored in one chunk reuses its SHA-256 digest. A layout shorter than a SHA-256 key uses its exact tuple bytes as the index key. The reader and writer also recognize the original SHA-keyed layouts.

A WAL transaction commits the checkpoint record and its head together. Graph changes and their witnesses also share a transaction. Independent host and Direct execution leases still govern external side effects. New media that match existing native originals or request-image bytes are pinned with verified hard links on the same filesystem. An unmatchable image is stored losslessly in the database. If the native service removes its own copy, the pinned inode still occupies space until its references retire.

## Unit snapshots

Version 2 unit graphs use `storageFormat: "units-v2"` in the state and the committed witness. Each node has `kind: "unit"` and a direct or planned mode. The `graph.state.units` map holds execution and audit records under the same stable unit ID. Context bindings, reports and supervised outcomes use `unitId`. The adapter reads earlier snapshots and writes the unit representation on the next successful commit. Event payloads and their original checksum domain are preserved for verification. Both storage backends use the same representation.

## Recovery

Durable Direct execution observes the current source metadata before admission. Callers waiting to start share an asynchronous scan. A request arriving after the scan starts gets a fresh scan. Changed sources are read through an open file descriptor and checked against the path again before their digest is accepted.

A background worker takes a consistent backup at durable boundaries. Clean close waits for outstanding backup work. WAL transactions remain the crash-recovery record between backups. Recovery under `recovery/` keeps the two most recent database generations in shared, compressed 64 KiB page groups and immutable packs of at most 8 MiB. Changed page groups can share a single verified full base when their compressed XOR difference saves space. The manifest retains every base required by either generation and bounds decoding to one delta. A generation retains the image pins it needs. Interrupting a writer releases the operating system's SQLite locks. Busy snapshots are retried at a subsequent boundary. Backup and lazy readers verify their inputs.

For offline restoration, retain the instance directory, both identity markers, `recovery/`, and `media-pins/`. With the instance stopped, call `restoreWorkflow(absoluteRecoveryDirectory, absoluteNewDatabasePath, optionalGenerationId)` from `./workflow-backup.mjs`. It uses the latest generation by default, verifies its complete database hash and pinned images, and requires a previously unused destination beside the retained pins. It reconstructs empty role and attempt directories from the verified file index, including the directories needed for a paused continuation. Native working files, session logs, locks and external effects remain separately owned. Verify the restored state before replacing a damaged database. Restoring state by itself never dispatches a model request or repeats a tool effect.

## Verification

`npm test` runs the normal suite. `npm run test:storage` exercises fresh storage, historical selection, independent instances, crash/restart, lost files, media, display paging and restoration. `npm run test:hotpaths` marks functional success green or yellow and reports source locations, operation counts, distinct paths where available, and processed bytes. A functional assertion still fails the command. The probe instruments only an explicit diagnostic scope. The historical replay and stress commands under `scripts/` consume isolated temporary databases and delete them at the end, preserving only their measurement output.
