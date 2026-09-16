---
name: project-management
description: Read and operate projects through procli, including natural-language project/task/node matching, directory and task inspection, concurrency-safe node and task creation, recoverable node/task deletion and restoration, project creation, administrator deletion, and local/NAS target selection. Invoke this Skill only when the user's request explicitly contains the keyword "procli" or explicitly asks to use procli.
---

# Project Management

Use the bundled `procli` executable as the only execution surface. Load the current `capabilities.json` and the adapter matching the advertised Agent platform before acting. Resolve the live CLI version and capabilities at runtime; do not call service APIs directly.

`procli` is the global explicit trigger word for this Skill. When it appears as the requested project-operation tool, route here even if the user does not mention the Skill name. Infer the operation and structured inputs from the surrounding natural language, then follow the matching main line.

The logical capabilities are `project.service.directory.list`, `project.service.task.list`, `project.service.task.read`, `project.service.node.create`, `project.service.node.delete`, `project.service.node.restore`, `project.service.task.create`, `project.service.task.delete`, `project.service.trash.list`, `project.service.task.restore`, `project.service.project.create`, and `project.service.project.delete`. If the matching adapter mapping is unresolved or unsupported, return `CAPABILITY_UNAVAILABLE`.

## Contract

- Input: an explicit `procli` trigger plus a project-management intent. Project, folder, stage, skill, and task references may be natural-language fragments rather than exact stored names; write operations retain their existing authorization inputs.
- Strategy: select the requested Profile, verify the target, use read-only procli listings to resolve natural-language references to exact stored names, communicate the resolution or ambiguity, then execute the matching structured procli command.
- Output: report the selected target and the CLI's structured project/task data. Read paths must not use write flags, idempotency keys, direct service APIs, or mutate project state.

## Target routing

The default Profile is `nas`. Respect this precedence exactly:

```text
--profile > PROCLI_PROFILE > saved current Profile > nas
```

Run `procli profile current --json` and `procli doctor --json` before a write. Use `--profile local` for a one-command development override. Change the saved Profile only when the user asks for a persistent switch. Never silently switch environments after a connection or authentication failure.

## Read project information

These commands are read-only and do not require write confirmation. Use `--profile <name>` only when the user requests a non-current target.

- For existing folders and projects:

  ```bash
  procli directory list --json
  ```

  Preserve folder IDs, project-to-folder relationships, pinned state, timestamps, task counts, and progress from the JSON result.

- For all task nodes in one project:

  ```bash
  procli task list --project "<exact project name>" --json
  ```

  Return every task in service order with its current status, ownership, dependencies, work description, acceptance criteria, Wiki path, and timestamps.

- For the complete state and records of one task node:

  ```bash
  procli task get --project "<exact project name>" --task "<exact task name>" --json
  ```

  Report the full current task, resolved dependencies and dependents, status history, activity events, Agent runs, artifact metadata, Wiki metadata, and notifications. Do not describe an absent record collection as an error; preserve it as an empty array or `null` according to the CLI result.

### Resolve natural-language references

The CLI accepts exact names, while the Skill accepts the shorter and less formal expressions people normally use. Resolve them only through current read-only procli results; never inspect the service database or project files directly.

1. Run `procli directory list --json` and normalize the user's reference for Unicode form, whitespace, case, and ordinary punctuation.
2. Resolve the project context in this order:
   - exact active-project name;
   - exact folder name, using the folder's `projectIds` to obtain its projects;
   - a unique clear containment match against active project and folder names.
3. If a folder resolves to exactly one project, use that project. If several projects remain plausible, show their exact names and ask one concise clarification question. Do not select by directory order or recency.
4. Run `procli task list --project "<exact project name>" --json`. Match the user's task phrase against each node's `title`, `stage`, and `skill`, preferring an exact field match and then a unique clear containment match.
5. If exactly one task remains, use its exact `title` with `procli task get`. If zero or several remain, show the closest exact task titles with their current statuses and ask the user to clarify. Never silently substitute a merely similar task.
6. In the result, briefly state the resolved folder/project/task mapping before reporting the requested status and records. A unique high-confidence mapping does not require an extra confirmation turn.

For example, a request about a folder followed by a short task topic can be resolved by composing `directory list`, `task list`, and `task get`; do not pass the folder name or short topic directly into an exact-name CLI argument.

## Add a task

Task creation is a state-dependent write. The web workspace and `procli` may both modify the same project, so never construct and send a task from remembered conversation state or a previous task listing.

1. Resolve the exact project name with the read-only natural-language flow above. Read the authoritative compact creation context immediately before composing the write:

   ```bash
   procli task create-context --project "<exact project name>" --json
   ```

   Use its exact node names, task names, members, constraints, `projectVersion`, and `contextToken`. Do not inspect the webpage, database, Markdown files, or `/api/state` directly.

2. Required business inputs are the exact project, node, and a project-unique task title. Turn the user's stated work into a concise non-empty description when its meaning is clear. Ask one concise question only when the work, project, node, person, dependency, or placement remains materially ambiguous.
3. Resolve a named owner or reviewer against the returned member ID/name. Resolve dependencies and `before`/`after` references against exact task names. Do not infer a dependency merely from node order. With no placement request, append to the end of the node.
4. Generate one UUID for the logical write attempt. Run the authoritative server preview with the context token:

   ```bash
   procli task create --project "<project>" --node "<node>" --title "<title>" \
     --description "<description>" --context-token "<token>" \
     --idempotency-key "<uuid>" --dry-run --json
   ```

   Add `--owner`, `--reviewer`, `--priority`, `--due-date`, `--depends-on`, `--before-task`, `--after-task`, or `--skill` only when supported by the request and current context.

5. Check the preview's target, exact project/node, title, people, dependencies, and insertion position. The user's instruction to add the task authorizes the matching local write. Production additionally requires `--yes`.
6. Execute the identical command without `--dry-run`, preserving the context token and idempotency key. Accept success only when the CLI returns `verification=write-after-readback`, the created task ID, the expected exact project/node/title, and an advanced project version.
7. On `PROJECT_STATE_CHANGED`, do not retry the write immediately. Return to Step 1 and obtain a new context. If the change affects uniqueness, target resolution, dependency, owner, or insertion position, show the changed candidates and ask the user; otherwise rebuild the preview with the same logical intent and idempotency key.

## Add a board node

A node is one board stage/column, not a task inside that column.

1. Resolve the exact project through the read-only natural-language flow and read the authoritative compact context immediately before composing the write:

   ```bash
   procli node create-context --project "<exact project name>" --json
   ```

2. The node name is required and must be unique within the project. Resolve a requested before/after position against the returned exact node names. With no position request, append the node to the project end. Ask one concise question only when the target project, node name, or position remains materially ambiguous.
3. Generate one UUID and preview with the returned token:

   ```bash
   procli node create --project "<project>" --name "<node>" \
     --after-node "<reference node>" --context-token "<token>" \
     --idempotency-key "<uuid>" --dry-run --json
   ```

   Omit `--before-node` and `--after-node` when appending.

4. Check the exact project, node name, insertion order, reference node, Profile, and environment. The user's instruction to add the node authorizes the matching local write; production additionally requires `--yes`.
5. Execute the identical command without `--dry-run`. Accept success only with the expected exact node name and order, an advanced project version, and `verification=write-after-readback`.
6. On `PROJECT_STATE_CHANGED`, obtain a fresh context. If node names or the requested position changed, ask the user to disambiguate; otherwise rebuild the preview with the same logical intent and idempotency key.

## Recoverably delete a board node

Node deletion always requires a fresh impact preview and explicit exact-name confirmation. It archives the node, its tasks, Wiki files, artifacts, execution records, and related metadata as one recycle batch.

1. Resolve the exact project and node using current procli results, then read the deletion context:

   ```bash
   procli node delete-context --project "<project>" --node "<node>" --json
   ```

2. Preview with dependency policy `block` by default:

   ```bash
   procli node delete --project "<project>" --node "<node>" \
     --confirm-node "<exact node>" --dependency-policy block \
     --dry-run --json
   ```

   Show the node order, task count, content-bearing task count, Wiki/file and record counts, external dependents, permission requirement, recoverability, and 90-day retention.

3. If tasks in other nodes depend on tasks being deleted, ask whether to cancel or explicitly detach those dependencies. Use `--dependency-policy detach` only after that choice; never detach silently. Node deletion does not guess a replacement task.
4. Obtain explicit confirmation naming the exact node. Empty nodes and nodes containing only empty tasks may be deleted by ordinary authenticated users. A node containing Agent execution or substantive output requires administrator authorization. The project must retain at least one node. Production additionally requires `--yes`.
5. Execute the same command without `--dry-run`, preserving one idempotency key. Accept success only with `scopeType=node`, a `deletionId`, completed manifest, task count, retention time, advanced project version, and `delete-after-readback` verification.
6. On `PROJECT_STATE_CHANGED` or `DELETE_SCOPE_CHANGED`, restart from Step 1 and obtain a new confirmation for the changed impact.

## Restore a board node

Read the node-scoped recycle record and preview conflicts before restoration:

```bash
procli node restore --deletion-id "<id>" --confirm-node "<exact node>" \
  --dry-run --json
```

Show same-name node, same-name task, and file conflicts. After exact-name confirmation, execute the same command with one idempotency key; production additionally requires `--yes`. Accept success only when the original node name, tasks, files, records, and available dependencies are restored, the node is verified by exact-name readback, and `verification=restore-after-readback`. Report warnings for downstream tasks or dependencies that no longer exist.

## Create a product project

1. Collect the project name; it is the only required business input. Use the user's stated outcome as `--goal` when available.
2. Project type defaults to `product`. Report shop and company project creation as `FEATURE_UNSUPPORTED` until the CLI advertises those capabilities.
3. If the user wants the standard product lifecycle, omit `--sop-file`; the service initializes the default SOP, sequential tasks, and their Wiki pages.
4. If the user supplies a custom SOP, obtain both `name` and `description` for every node. Ask the user for missing meaning, or offer a clearly labeled draft for approval. Never send an incomplete node. Save the approved structure as JSON in this form:

   ```json
   { "nodes": [{ "name": "节点名称", "description": "节点工作说明" }] }
   ```

5. Generate one UUID for the logical attempt and preserve it across retries. Preview with the same arguments and idempotency key:

   ```bash
   procli project create --name "<name>" --goal "<goal>" --sop-file "<file>" --idempotency-key "<uuid>" --dry-run --json
   ```

   Omit `--goal` or `--sop-file` when unused.

6. Show the selected Profile, URL, environment, project name, SOP mode, and node count. The user's request to create is authorization for the local write. Production additionally requires `--yes`.
7. Execute the matching command. Accept success only when `ok=true`, the target matches the preview, and the CLI returns a write-after-readback project, task count, and Wiki count.

## Recoverably delete a task

Task deletion always requires a fresh impact preview and a separate user confirmation. Never use the legacy task DELETE endpoint, inspect the database directly, or infer the deletion scope from a previous read.

1. Resolve the exact project and task through the read-only natural-language flow. Read the current deletion context:

   ```bash
   procli task delete-context --project "<project>" --task "<task>" --json
   ```

2. Preview with the default dependency policy `block` unless the user explicitly requested `detach` or `rewire`:

   ```bash
   procli task delete --project "<project>" --task "<task>" \
     --confirm-task "<exact task>" --dependency-policy block --dry-run --json
   ```

   For `rewire`, also provide `--rewire-to "<exact same-project task>"`. Show the selected Profile, exact task, content status, Wiki and file count, runs, dependent tasks, policy, recoverability, and 90-day retention.

3. If dependents exist under `block`, ask whether to cancel, detach them, or rewire them to one exact current task. Re-run the preview after the choice. Do not silently detach dependencies.
4. Obtain explicit confirmation for the displayed impact. The confirmation must name the exact task. Content-bearing tasks require administrator authorization. Production additionally requires `--yes`.
5. Execute the same command without `--dry-run`, preserving the chosen policy and one idempotency key. Accept success only with a `deletionId`, `completed` state, manifest path, retention time, advanced project version, and `delete-after-readback` verification.
6. On `PROJECT_STATE_CHANGED` or `DELETE_SCOPE_CHANGED`, return to Step 1, display the changed impact, and obtain a new confirmation. On an unknown result, retry only with the same idempotency key.

## Read the recycle bin and restore a task

- List or inspect recoverable deletions without mutation:

  ```bash
  procli trash list [--project "<project>"] --json
  procli trash get --deletion-id "<id>" --json
  ```

- To restore, uniquely resolve the deletion record, preview first, show conflicts and files, then obtain exact task-name confirmation:

  ```bash
  procli task restore --deletion-id "<id>" \
    --confirm-task "<exact task>" --dry-run --json
  procli task restore --deletion-id "<id>" \
    --confirm-task "<exact task>" --idempotency-key "<uuid>" --json
  ```

  Production additionally requires `--yes`. Accept success only with the original task ID, warnings, advanced project version, and `restore-after-readback` verification. Multiple plausible “刚才删除的任务” records require the user to select an exact `deletionId`.

## Delete a project

Deletion is a recoverable soft delete, but it is a high-risk administrator action.

1. Collect the exact project name and generate one UUID for the logical attempt.
2. Preview the target and affected counts:

   ```bash
   procli project delete --name "<exact name>" --confirm-name "<exact name>" --idempotency-key "<uuid>" --dry-run --json
   ```

3. Present the Profile/environment, exact name, task count, Wiki count, administrator requirement, and recoverable status. Obtain explicit confirmation if it is not already present in the current request.
4. Execute the identical request with `--yes`. Both name arguments must match exactly. The authenticated identity must have `systemRole=admin`.
5. Accept success only when the CLI returns `verification=soft-delete-readback`, `deletedAt`, and `recoverable=true`.

## Failure branches

- `PROFILE_NOT_CONFIGURED`: provide the required `procli profile add` command and stop.
- `TARGET_MISMATCH` or `API_VERSION_UNSUPPORTED`: stop without writing.
- `AUTH_REQUIRED`: run `procli auth login --profile <name>` only when interactive browser authorization is available; otherwise provide the command.
- `PROJECT_NAME_CONFLICT`: ask for a distinct active-project name.
- `SOP_NODE_INCOMPLETE`: return to custom-SOP collection and obtain both required fields.
- `CONFIRMATION_REQUIRED`: preserve the idempotency key, obtain confirmation, then resume the matching write.
- `ADMIN_REQUIRED`: tell the user to contact the system administrator; do not seek a bypass.
- `DELETE_CONFIRMATION_MISMATCH`: request the exact project name and rebuild the preview.
- `SERVICE_UNAVAILABLE`: report the selected Profile and stop without changing environments.
- `NOT_FOUND` on a read: state whether the project or task was not found and request an exact name; do not substitute a similar item.
- `TASK_NAME_AMBIGUOUS`: report the conflicting task IDs and ask the user to disambiguate; do not choose one silently.
- `CONTEXT_TOKEN_REQUIRED`: return to task creation Step 1 and obtain a current context token.
- `PROJECT_STATE_CHANGED`: return to task creation Step 1; never write with the stale token.
- `TASK_NAME_CONFLICT`: ask for a distinct project-wide task title.
- `STAGE_NAME_CONFLICT`: ask for a distinct project-wide node name.
- `POSITION_NODE_INVALID`: show the exact current nodes and ask for a valid before/after location.
- `LAST_NODE_REQUIRED`: explain that every project must retain at least one node and stop.
- `DEPENDENTS_EXIST`: show the exact dependents and ask the user to cancel, detach, or rewire; never choose a destructive policy automatically.
- `DELETE_SCOPE_CHANGED`: restart the deletion context and preview flow, then request confirmation for the changed impact.
- `DELETE_CONFIRMATION_MISMATCH`: request the exact current task title and rebuild the preview.
- `RESTORE_CONFIRMATION_MISMATCH`: request the exact task title stored in the deletion manifest.
- `RESTORE_CONFLICT`: report the active task or file conflict and stop without overwriting or renaming.
- `RESTORE_SCOPE_MISMATCH`: report that the selected recycle record is not a node deletion record.
- `INVALID_RESTORE_STATE`: report the real recycle state and stop.
- `FEATURE_UNSUPPORTED` during deletion: the content Provider has no verified archive-and-restore contract; stop without mutation.
- `NODE_NOT_FOUND`, `MEMBER_NOT_FOUND`, `MEMBER_AMBIGUOUS`, `INVALID_DEPENDENCY`, or `POSITION_TASK_INVALID`: show the exact current candidates from a fresh creation context and ask one concise clarification question.
- Multiple natural-language candidates: report the exact candidate names and current statuses when available, ask one concise clarification question, and return to the relevant resolution step after the user answers.
- Unknown write result: retry only with the same idempotency key.

## Output contract

For directory reads, report folder/project counts and the requested structured listing. For task lists, report the project identity, task count, and all nodes. For task detail, report the current status plus all returned history and related record groups. For node creation, report the exact project/node, order, target Profile/environment, resulting project version, and write-after-readback verification. For recoverable node deletion, report the node, task/content counts, dependency policy, `deletionId`, manifest, retention, project version, target, and verification. For node restoration, report the node, restored task count, warnings, project version, target, and verification. For task creation, report the task ID/title, exact project/node, target Profile/environment, owner, placement, resulting project version, and write-after-readback verification. For recoverable task deletion, report the exact project/task, dependency policy, `deletionId`, manifest, retention time, project version, target, and verification. For task restoration, report the original task ID, deletion ID, warnings, project version, target, and verification. For project creation, report the project name and ID, target Profile/environment, SOP mode, task count, Wiki count, and verification. For project deletion, report the exact project name and ID, deletion time, actor, recoverable status, target, and verification. Never expose credentials or local token storage.

After a reported execution failure, preserve the failed command, structured error code, and target metadata for a separately authorized plugin update. Runtime execution must not edit this Skill or its adapters.
