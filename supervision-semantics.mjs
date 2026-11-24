// SPDX-License-Identifier: GPL-3.0-only
// Stable host protocol facts. These describe mechanics, not task acceptance.
export const supervisionSemantics = Object.freeze({
  version: 'supervised-runtime-v2',
  dispositions: {
    COMPLETE: { createsReport: true, satisfiesPrerequisite: true, meaning: 'The accepted current leaf disposition; not acceptance of the global objective.' },
    BLOCKED: { createsReport: false, satisfiesPrerequisite: false, meaning: 'An ended unsatisfied attempt. Preserve its evidence; future required work needs an existing recovery path or a reviewed revision.' },
    FAILED: { createsReport: false, satisfiesPrerequisite: false, meaning: 'An ended attempt with a known failed tool receipt. Unknown effects cannot be reported as known failure.' },
  },
  completionKinds: {
    report: 'A COMPLETE disposition commits a report after local review. Artifact citations are required only for an explicit local byte/digest obligation or an exact-byte claim; a JSON-value comparison alone does not acquire a byte-proof obligation from a global publication constraint.',
    artifact: 'A COMPLETE disposition also commits a report. Additionally the required file must have a host-verified reference; artifact never suppresses the report.',
  },
  relations: {
    prerequisite: 'An ordering/satisfaction edge. Removing it does not remove either leaf or any context binding.',
    contexts: 'Explicit node selection and transitive parent closure. Unselected history may remain without reaching future work.',
    inheritReports: 'Explicit report transfer. Prerequisites alone do not transfer reports. Source must be COMPLETE and its report valid at assembly.',
  },
  artifactReference: 'A path plus a computed or authorized expected digest requests host verification of current bytes. A separate prior host receipt or extra hashing tool is not required. Digest equality proves byte identity, not task correctness.',
  reportRepair: 'Repairs only the submission from existing evidence on the same attempt; performs no tools. Missing available citations can be repaired. Missing actual required work cannot be invented by rewriting the report.',
  history: 'Started tasks, their used context closures and execution receipts remain immutable. Corrections for future work use new bindings/nodes or new recovery tasks.',
  unknownEffects: 'Unknown model/tool effects retain the gate and require trusted reconciliation. Do not retry them as ordinary proposal defects.',
})

const unitSemantics = Object.freeze({
  ...supervisionSemantics,
  version: 'unit-runtime-v2',
  dispositions: {
    PASS: { createsReport: true, meaning: 'The unit met its acceptance criteria, supported by verified evidence.' },
    FAILED: { createsReport: false, meaning: 'Known failure is supported by a failed tool receipt or by verified evidence of an unmet acceptance criterion.' },
  },
  admission: 'BLOCK is assigned by the prerequisite state machine when no rule can pass. Agents submit PASS or FAILED.',
  completionKinds: {
    report: 'A reviewed PASS publishes the unit report. Evidence must support the stated acceptance criteria.',
    artifact: 'A reviewed PASS also requires verification of the declared artifact.',
  },
  relations: {
    prerequisite: 'Declared all, any and not expressions evaluate predecessor PASS, FAILED or BLOCK.',
    contexts: supervisionSemantics.relations.contexts,
    inheritReports: 'Explicit report transfer requires a published PASS report.',
  },
})

export const semanticsFor = plan => plan?.ruleVersion === 1 ? unitSemantics : supervisionSemantics
