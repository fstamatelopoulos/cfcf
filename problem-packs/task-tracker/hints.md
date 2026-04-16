# Technical Hints

## Suggested approach

Build in phases:
1. **Phase 1 -- Backend foundation**: Set up TypeScript project, Express server, task data model, basic CRUD endpoints, tests
2. **Phase 2 -- Backend polish**: Add validation, filtering, stats endpoint, error handling, more tests
3. **Phase 3 -- Frontend**: Build the UI, connect to API, add interactivity

## Testing

- Use Vitest or Jest for API tests
- Use `supertest` for HTTP endpoint testing (avoids starting a real server)
- Aim for at least 15 tests covering all CRUD operations and edge cases

## Project structure suggestion

```
/
  src/
    server.ts          # Express app setup
    routes/
      tasks.ts         # Task route handlers
    models/
      task.ts          # Task type + in-memory store
    middleware/
      validation.ts    # Request validation
  public/
    index.html         # Frontend entry point
    styles.css         # Styles
    app.js             # Frontend JavaScript
  tests/
    tasks.test.ts      # API tests
  package.json
  tsconfig.json
```
