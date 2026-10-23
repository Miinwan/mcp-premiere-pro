# Project clean-up after delivery — use when a finished job should be slimmed down: remove unused media from the Premiere project and move unused files (with their proxies) to the Trash.

Workflow settled on 2026-10-23: no consolidated copy (Project Manager is unreliable). Review what is unused, remove it from the project, move the leftover files to the Trash; the owner checks the Trash and empties it. Only files in use are kept, in case the client asks for changes; the original camera files are archived elsewhere.

1. `review_unused_media { keepSequences? }`: read-only. Usage is computed from the timelines (nested sequences and multicam included). Without `keepSequences` every sequence is kept; with the names of the delivered sequences, the other sequences go on the removal list too. The result is a JSON report in `~/Library/Application Support/MCP Adobe/Don dep/` plus a summary: items to remove from the project, files to the Trash, space freed, the 20 largest files.
2. Show the list to the user. Only after they agree, run `clean_unused_media { report, confirm: true }`: saves a project checkpoint, re-checks usage (anything used since is skipped), removes the items from the project (and bins emptied by it), saves the project, then Finder moves the files to the Trash (Put Back works).

Only files inside the job folder can go to the Trash. The job folder is the folder holding the project; if that folder is named like Project, Premiere or AE, its parent is used (change it with `jobFolder`). Files from elsewhere on the Mac (SFX from Soundly, music libraries, shared assets) are never touched; they are only removed from the project when unused.

Goes to the Trash (inside the job folder):
- Imported files that are on no timeline, with their proxies (the attached proxy, or the one in the `Proxies` folder next to the source).
- Media files in the source folders (and `Proxies`) that were never used, including audio, stills, PSD and SRT.

Always kept:
- Files in use and their proxies (unless `trashProxiesOfUsed: true`).
- Delivery/render folders: Edited, Export, Xuất file, Render, Output, Final, Bàn giao.
- Non-media files, `.prproj`/`.aep` projects, and the rest of an image sequence in use.

Notes: files in the source folders may be used by another project; read the list before cleaning. The first time, macOS asks for permission to control Finder; if it is blocked, open System Settings → Privacy & Security → Automation. After Effects has matching ops (`project.review_unused`, `project.clean_unused`) with the same report format.
