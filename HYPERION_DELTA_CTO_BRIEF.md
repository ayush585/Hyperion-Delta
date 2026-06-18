# Hyperion Delta CTO Brief

Version: `v0.1.7`  
Package: `hyperion-delta`  
Runtime: Node.js 20+

## 1) One-line pitch

Hyperion Delta is a local AI-agent runtime reliability layer that makes rollback scale with changed files (dirty set), not repository size, so teams can run more autonomous attempts safely.

## 2) Why this exists

AI coding systems fail frequently by design (generate -> test -> fail -> retry). The hidden cost is not model tokens alone; it is repeated filesystem rollback latency and workspace safety risk.

Without dirty-set-aware rollback, teams pay a full-repo reset tax on every failed branch. That directly reduces exploration depth and product iteration speed.

## 3) What Hyperion does

Hyperion provides checkpointed local attempt isolation with:

- fast `snapshot` / `fork` / `rollback`
- mandatory pre-rollback reconcile firewall for child-process/native writes
- deterministic branch lifecycle APIs for multi-agent contention
- typed conflict rejection for incompatible same-path branch outcomes
- durable attempt journals and rehydrate flows
- strict ignored-path controls with explicit tool-output allowlists

What it does not do:

- Git history, merges, remotes, signatures, push/pull workflows

Git remains the permanent history layer. Hyperion is the fast attempt layer.

## 4) Proof (benchmark evidence)

Final audit (50,000-file workspace, 10 rollback samples):

- Git reset+clean: `3,478.407 ms` avg
- Hyperion manifest rollback: `0.971 ms` avg (`3,580.50x` faster)
- Hyperion tmpfs dirty-set rollback: `0.063 ms` avg (`54,851.92x` faster)

Supporting sweeps:

- Dirty-set scaling (Windows NTFS):
  - 1 dirty file: `4.325 ms`
  - 100 dirty files: `298.908 ms`
- Repo-size independence (10 dirty files):
  - 1,000 files: `21.326 ms`
  - 5,000 files: `13.410 ms`
- Windows-native, no Git hot-path dependency:
  - 10,000-file repo, 10 dirty files: `62.034 ms` avg rollback

Bottom line: rollback cost follows changed paths, not tree size.

## 5) Safety and correctness posture

Core controls:

- Reconcile firewall before rollback (cannot be disabled)
- Atomic restore (same-directory temp write + rename)
- Typed integrity failures (`HyperionIntegrityError`) instead of silent partial restores
- Strict ignored-write blocking (`strictIgnoredWrites`) with typed errors
- Exact-path tool contracts (`declareToolOutputs`) for legitimate ignored-root outputs
- Branch conflict typing (`HyperionBranchConflictError`) with reject-only conflict mode

Reliability evidence:

- cross-platform unit matrix (Linux/Windows/macOS)
- failure-injection suite
- fuzz smoke + reconcile fuzz
- stress smoke
- branch contention stress
- repeatability gate

## 6) Core APIs for integration

Runtime entry points:

- `HyperionWorkspace`
- `HyperionAgentSession`

High-value methods:

- `runAttempt`, `snapshot`, `fork`, `runInBranch`
- `reconcile`, `rollback`, `dropBranch`, `promote`, `promoteBranch`
- `recoverAttempts`, `rehydrateAttempt`, `exportPatch`
- `getDiagnostics`, `declareToolOutputs`

Branch lineage metadata available on checkpoints:

- `parentId`, `branchId`, `subagentId`, `agentId`, `createdBy`

## 7) Minimal integration shape

```ts
import { HyperionAgentSession } from "hyperion-delta";

const session = new HyperionAgentSession(process.cwd());

try {
  const attempt = await session.runAttempt(async ({ exec }) => {
    await runAgentMutationCycle();
    await exec("npm", ["test"]);
  });

  await session.promote(attempt.checkpointId);
} finally {
  await session.dispose();
}
```

For multi-agent branch exploration, use `fork` + `runInBranch` + `promoteBranch` (`conflictMode: "reject"`).

## 8) Business impact framing

Where this pays off:

- more attempts per unit time in autonomous coding loops
- lower chance of workspace corruption after failed runs
- safer parallel branch exploration by multiple agents
- reduced dependence on full-repo reset behavior as runtime throughput grows

In short: better reliability and throughput without changing the team's Git ownership model.

## 9) 4-week pilot plan (suggested)

Week 1:

- wire `runAttempt` into one target agent execution path
- add baseline telemetry (`getDiagnostics`, rollback latency, failed-attempt count)

Week 2:

- enforce strict ignored writes
- add `declareToolOutputs` for known generated artifacts

Week 3:

- enable branch APIs for parallel candidate evaluation
- validate conflict rejection behavior under overlapping paths

Week 4:

- run reliability gate + platform matrix
- produce before/after metrics and rollout recommendation

Success metrics:

- median/p95 rollback latency
- attempts per hour
- rollback integrity incident count (target: zero)
- cross-branch contamination incidents (target: zero)

## 10) Decision checklist for technical adoption

- Need faster local attempt retries than Git reset allows?
- Need safer child-process/native-tool mutation handling?
- Need deterministic branch conflict handling for multi-agent runs?
- Need dirty-set rollback with explicit diagnostics and typed errors?

If yes to most: Hyperion Delta is a strong fit as the local attempt reliability layer.

## 11) References

- `HYPERION_DELTA_FULL_CONTEXT.md`
- `README.md`
- `ARCHITECTURE.md`
- `LIMITATIONS.md`
- `docs/src/content/docs/benchmark/results.md`
- `docs/src/content/docs/benchmark/windows.md`
