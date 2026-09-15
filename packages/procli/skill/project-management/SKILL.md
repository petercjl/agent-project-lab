---
name: project-management
description: Read and operate projects through procli, including directory/project listing, task-node listing and record inspection, product-project creation, administrator deletion, and local/NAS target selection. Always use when the user explicitly says "procli" or asks to use procli.
---

# Project Management

Use the bundled `procli` executable as the only execution surface. Load the current `capabilities.json` and the adapter matching the advertised Agent platform before acting. Resolve the live CLI version and capabilities at runtime; do not call service APIs directly.

`procli` is the global explicit trigger word for this Skill. When it appears as the requested project-operation tool, route here even if the user does not mention the Skill name. Infer the operation and structured inputs from the surrounding natural language, then follow the matching main line.

The logical capabilities are `project.service.directory.list`, `project.service.task.list`, `project.service.task.read`, `project.service.project.create`, and `project.service.project.delete`. If the matching adapter mapping is unresolved or unsupported, return `CAPABILITY_UNAVAILABLE`.

## Contract

- Input: a directory-list intent, or an exact project name and optionally an exact task-node name; write operations retain their existing authorization inputs.
- Strategy: select the requested Profile, verify the target, execute the matching structured procli command, and distinguish missing or ambiguous names from empty results.
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
- Unknown write result: retry only with the same idempotency key.

## Output contract

For directory reads, report folder/project counts and the requested structured listing. For task lists, report the project identity, task count, and all nodes. For task detail, report the current status plus all returned history and related record groups. For creation, report the project name and ID, target Profile/environment, SOP mode, task count, Wiki count, and verification. For deletion, report the exact project name and ID, deletion time, actor, recoverable status, target, and verification. Never expose credentials or local token storage.

After a reported execution failure, preserve the failed command, structured error code, and target metadata for a separately authorized plugin update. Runtime execution must not edit this Skill or its adapters.
