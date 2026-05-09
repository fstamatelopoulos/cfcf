# docs/ -- cfcf Documentation

## Structure

```
docs/
  plan.md               Working docs: development roadmap, decision log
  decisions-log.md      Working docs: failed experiments, non-obvious choices

  design/               Specs and architecture (stabilize over time)
    cfcf-requirements-vision.md     What cfcf is and why
    cfcf-stack.md                   Technology choices
    technical-design.md             How components fit together
    agent-process-and-context.md    Iteration process, file formats, signal specs
    clio-memory-layer.md            Clio architecture (item 5.7+)
    clio-memory-web-ui.md           Clio web UI design (item 6.18)
    scheduler-and-update-notification.md  JobScheduler primitive + update banner (item 6.20)
    role-template-management.md     Role-template versioning + promote-to-production (item 6.8)
    skills-repository.md            Skills system design (item 6.27)

  api/                  API reference (grows with every endpoint)
    server-api.md       Server REST API endpoints

  research/             Ideas, brainstorms, explorations (promoted to design/ when committed)
    reflection-role-and-iterative-planning.md   Item 5.6 design (shipped in v0.6.0 + v0.7.0)
    product-architect-design.md                  Item 5.14 design (shipped)
    structured-pause-actions-design.md           Item 6.25 design (shipped)
    …                                            (other historical research files)

  guides/               User-facing how-tos
    manual.md             User-manual hub — 3-min getting started + concepts + pointers
    workflow.md           Full workflow walkthrough (canonical for "run a loop end-to-end")
    cli-usage.md          CLI command reference (verb-by-verb)
    clio-quickstart.md    Clio (cross-workspace memory) onboarding
    installing.md         Install + upgrade + uninstall
    troubleshooting.md    Common issues + fixes
    anthropic-policy.md   Anthropic third-party-harness policy + adapter strategy (item 6.28+6.30)
    product-architect.md  Product Architect interactive role (item 5.14)
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
