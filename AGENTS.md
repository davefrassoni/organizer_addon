# Agent Preferences

## Feature completion
- After each completed feature or finished user-requested task, commit only the intended files and push directly to `origin/main` before replying that the work is done.
- For remote SSH work from this Windows workstation, use `C:\Users\origi\code\agent-quoting.ps1` rather than composing shell commands directly.

## Project board (Dave Board)

This project's progress is tracked at https://davefrassoni.com/board/
(project: "Organizer Add-on"). If `DF_BOARD_API_KEY` is set in `.env`, use it:

- Base URL: `https://davefrassoni.com/board/api/v1/`
- Auth header: `Authorization: Bearer <DF_BOARD_API_KEY>`
- `GET state/` — current tasks/categories for this project.
- `POST tasks/` — file a new task (`title`, `description`, `status`, `priority`, `category`).
- `PATCH tasks/<id>/` — move/update a task (e.g. `status: "done"`).
- `DELETE tasks/<id>/` — remove a task that's no longer relevant.

After finishing a feature: check `GET state/`, mark the matching task `done`
(or create one describing what shipped) with a short detail note. File newly
discovered pending work as `todo`/`backlog`. Periodically reconcile: move
stale `in progress`/`todo` items that are actually done, and delete tasks
that no longer reflect the project.
