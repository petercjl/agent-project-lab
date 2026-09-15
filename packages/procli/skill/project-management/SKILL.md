---
name: project-management
description: Create and manage projects in a procli-compatible project management service. Use when a user asks to create a new product project, choose between local development and NAS production, or verify which project environment an Agent will modify.
---

# Project Management

Use the bundled `procli` executable as the only execution surface. Do not call the service API directly or infer success from prose.

## Input → Strategy → Output

- Input: project name is required; goal is optional; profile is optional and defaults through procli to `nas`.
- Strategy: discover the live target, preview the write, obtain confirmation for production, create with one idempotency key, then require the CLI's write-after-readback result.
- Output: the selected target, project record, generated task and Wiki summary, idempotency key, and an explicit success or structured error.

## Main line: create a project

1. Run `procli profile current --json`, then `procli doctor --json`. If the selected Profile is missing, unreachable, mismatched, or unauthenticated, stop and report the structured error.
2. Collect the project name. Use the user's stated business outcome as `--goal`; do not invent a detailed goal when it would change project intent.
3. Generate one UUID for this logical creation attempt and retain it across retries as `--idempotency-key`.
4. Run a preview:

   ```bash
   procli project create --name "<name>" --goal "<goal>" --idempotency-key "<uuid>" --dry-run --json
   ```

5. State the previewed Profile, URL, environment and project name. A production write requires the user's explicit creation intent; once present, execute the same request with `--yes`. A local development write does not require `--yes`.
6. Accept success only when the CLI returns `ok=true`, the target matches the preview, and the result contains the created project plus generated task and Wiki counts.
7. Report the project name, ID, target Profile/environment and generated structure. Never expose stored credentials.

## Profile routing

The default Profile is `nas`. Respect the CLI precedence exactly:

```text
--profile > PROCLI_PROFILE > saved current Profile > nas
```

Use `--profile local` for a one-command development override. Use `procli profile use local` only when the user asks to persistently change the default. Never replace a named Profile with a raw URL during normal execution.

## Failure branches

- `PROFILE_NOT_CONFIGURED`: show the required `procli profile add` command and stop.
- `TARGET_MISMATCH` or `API_VERSION_UNSUPPORTED`: stop without writing; do not bypass instance verification.
- `AUTH_REQUIRED`: run `procli auth login --profile <name>` only when interactive browser authorization is available; otherwise return the login command.
- `CONFIRMATION_REQUIRED`: show the target and wait for explicit authorization; then return to main-line step 5 with the same idempotency key.
- `SERVICE_UNAVAILABLE`: do not switch from local to NAS or from NAS to local automatically. Report the selected Profile and stop.
- Unknown write result: retry only with the same idempotency key. Never create a second logical attempt merely because the response was interrupted.

## Capability contract

Before execution, load `capabilities.json` and the adapter matching the advertised Agent platform. The required logical capability is `project.service.project.create`. If its mapping is unresolved or unsupported, return `CAPABILITY_UNAVAILABLE`; do not guess another API or CLI.

After a reported execution failure, preserve the failed command, structured error code and target metadata for a separately authorized plugin update. Runtime execution must not edit this Skill or its adapters.
