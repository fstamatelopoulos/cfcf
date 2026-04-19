# docs/ -- cfcf Documentation

## Structure

```
docs/
  plan.md               Working docs: development roadmap, decision log
  decisions-log.md      Working docs: failed experiments, non-obvious choices

  design/               Specs and architecture (stabilize over time)
    cfcf-requirements-vision.md   What cfcf is and why
    cfcf-stack.md                 Technology choices
    technical-design.md           How components fit together
    agent-process-and-context.md  Iteration process, file formats, signal specs

  api/                  API reference (grows with every endpoint)
    server-api.md       Server REST API endpoints

  research/             Ideas, brainstorms, explorations
    reflection-role-and-iterative-planning.md   Item 5.6 design (shipped in v0.6.0 + v0.7.0)

  guides/               User-facing how-tos
    workflow.md         Full user workflow walkthrough (the main user guide)
    cli-usage.md        CLI command reference
```

## What Goes Where

| I want to... | Put it in... |
|--------------|-------------|
| Track development progress, record decisions | `plan.md` |
| Record a failed experiment or non-obvious choice | `decisions-log.md` |
| Define or update system architecture | `design/` |
| Document an API endpoint | `api/` |
| Brainstorm an idea not yet committed to the plan | `research/` |
| Write a how-to for end users | `guides/` |

## Conventions

- All docs are Markdown.
- Design docs reference each other by relative path (e.g., `../plan.md`, `technical-design.md`).
- Living docs (`plan.md`, `decisions-log.md`) are updated frequently. Design docs stabilize over time.
- New research topics get their own file in `research/`. Promoted to `design/` when they become part of the plan.
