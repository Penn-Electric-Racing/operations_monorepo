# operations_monorepo

Penn Electric Racing operations tooling. One repo, one project per directory.

| Directory | What it does |
| --- | --- |
| [`notion-github-sync/`](notion-github-sync/) | Mirrors GitHub issues and pull requests from every PER repo into the Notion project board. |

Each directory is self-contained: read its own README and run its commands
from inside it.

Reusable workflows live in `.github/workflows/` at the root, because GitHub
only loads them from there.
