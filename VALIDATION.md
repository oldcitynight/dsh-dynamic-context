# Candidate validation: 0.1.0-rc.24

The candidate was validated on 2026-11-13 with DSH 0.2.1-rc.5 and task graph 0.3.0-rc.11.

| Check | Result |
| --- | --- |
| Source direct/fake suite | 348 passed |
| Installed direct/fake suite | 347 passed; 1 upstream-source comparison skipped |
| Companion task graph with dynamic imports forbidden | 103 passed |
| Legacy base compatibility | 101 passed |
| Native guarded development comparison | 23 passed with the external adapter hook |

The installed-package skip checks the copied native compaction prompt against a pristine upstream source tree, which is not included in the package. That check passed in the source workspace. The native guarded comparison is optional and does not run in the public direct CI job.

The fake suite uses a loopback HTTP backend, real DSH service registration, native tool dispatch, actual temporary file effects, and durable records. It covers per-session mode choices, missing prerequisites, partial proposals, graph loss, exact recovery, active-leaf exclusion, context boundaries, supervision, revision and audit.

No paid API was called for this candidate's boundary qualification. The evidence does not establish real-model task classification, planning quality, browser interaction, or semantic acceptance of arbitrary projects. Previous experiments and immutable candidate artifacts were preserved separately.

## Reproduce the public direct suite

Use Linux with Node.js 22.19+ or 24+, npm, Git, ripgrep, bubblewrap and util-linux. Bubblewrap must be able to create the required user/mount namespaces. The public CI workflow provisions these dependencies on its disposable runner.

```sh
npm ci
mkdir -p .test-tmp
TMPDIR="$PWD/.test-tmp" npm test
npm run pack:bundle
```

Keep the checkout and test state outside the host's `/tmp` tree: privacy tests deliberately reject private state inside the native shell's writable temporary area. `TMPDIR` above is scoped to the test command, not the user's global configuration.

The task-graph development dependency is pinned to its companion Git commit. Runtime consumers must also load the task-graph service; installing its source package alone does not satisfy the runtime prerequisite. No API credential is needed for these tests.
