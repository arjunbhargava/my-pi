# Known Issues — Team Agent Infrastructure

## Stale baseSha after file-moving refactors causes unresolvable rebase loops

**Observed:** 2026-05-20, team session `57e89baa`

### Symptoms

A task is repeatedly rejected with "Automatic rejection: Rebase conflicts on: <file>. Rework against the current target branch." The worker re-dispatches, rebases, and hits the same conflict again — indefinitely.

### Root cause

When a task is filed by the evaluator, its `baseSha` is recorded at filing time. If a subsequent task lands that **moves code to a different file** (e.g., splitting `resolver.ts` into `resolver.ts` + `bootstrap.ts`), the stale task's diff targets lines that no longer exist in the original file. Git cannot rebase this — the hunk context is gone.

The worker dutifully rebases onto the new `main`, but its commits still reference the old file structure. No amount of retries fixes this because the conflict is structural, not textual.

### Sequence that triggers it

1. Evaluator files task A (modifies `resolver.ts`) and task B (splits `resolver.ts` → `resolver.ts` + `bootstrap.ts`)
2. Task B lands first, rewriting `resolver.ts` and creating `bootstrap.ts`
3. Task A's worker rebases — conflict on `resolver.ts` because the lines it touches moved to `bootstrap.ts`
4. Evaluator rejects with "rebase conflicts", worker retries, same conflict forever

### Why the current design can't recover

- Workers don't have logic to detect "the code I need to modify moved to a different file"
- The evaluator's rebase-conflict rejection doesn't distinguish "textual conflict I can retry" from "structural conflict that requires re-scoping the task"
- `baseSha` is never updated on rejection — the task description still references the old file path

### Possible fixes

1. **Detect structural conflicts and re-scope**: If a rebase fails and the conflicting file was substantially rewritten (>50% of lines changed) or deleted, mark the task as needing re-scoping rather than re-dispatching. Surface this to the orchestrator with the new file layout so it can rewrite the task description.

2. **Update baseSha on rejection**: When the evaluator rejects for rebase conflicts, update the task's `baseSha` to `HEAD` of the target branch. This at least ensures the next worker starts fresh. (Doesn't solve the stale-file-path problem in the description, but prevents the "commit ahead of base" issue.)

3. **Sequentialize file-restructuring tasks**: The orchestrator should detect when two queued tasks touch the same file and one of them is a structural refactor (rename/split/move). Use `dependsOn` to force the refactor to land first, then re-file the other task with updated paths.

4. **Evaluator distinguishes conflict types**: On rebase failure, check whether the conflicting file's content at `HEAD` shares <30% similarity with the task's base version. If so, reject with a different status (e.g., `"stale-scope"`) that tells the orchestrator to re-file rather than re-dispatch.

### Workaround used

Killed the task from the queue and applied the fix manually on `main`. The change was trivial (5 lines in the new `bootstrap.ts` + 1 call-site in `resolver.ts`).
