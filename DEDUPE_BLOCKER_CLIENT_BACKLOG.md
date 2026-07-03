# Client backlog deduplication blocker

## Status
Blocked.

## Why blocked
The provided workspace snippets do not include any backlog storage for Client tasks (no tasks export, backlog markdown, seed JSON, or DB snapshot with task records).

## Required source to proceed
Provide one of:
- `storage/.../tasks.json` (or equivalent)
- `docs/backlog.md` / `backlog/client.*`
- SQL dump/table export for tasks
- API export containing Client project tasks

## What will be done immediately after source is provided
1. Filter tasks by target topics:
   - team response language
   - orchestrator comments
   - task statuses
   - automatic status management
2. Detect exact and near duplicates by normalized title + intent.
3. Keep one актуальная task per topic.
4. Remove/merge duplicates with traceable mapping.
5. Return final removed/merged list with IDs/titles.
