# Success Criteria

All of the following must pass for the project to be considered complete.

## Backend API Tests

The following scenarios must be verified by automated tests (using any test runner):

### Task CRUD
- [ ] `POST /api/tasks` creates a task and returns 201 with the created task (including generated id, createdAt, updatedAt)
- [ ] `POST /api/tasks` returns 400 when title is missing or empty
- [ ] `POST /api/tasks` returns 400 when title exceeds 200 characters
- [ ] `GET /api/tasks` returns all tasks as a JSON array
- [ ] `GET /api/tasks?status=todo` returns only tasks with status "todo"
- [ ] `GET /api/tasks/:id` returns a single task by ID
- [ ] `GET /api/tasks/:id` returns 404 for non-existent ID
- [ ] `PUT /api/tasks/:id` updates the task and returns the updated task
- [ ] `PUT /api/tasks/:id` updates the `updatedAt` timestamp
- [ ] `PUT /api/tasks/:id` returns 404 for non-existent ID
- [ ] `DELETE /api/tasks/:id` deletes the task and returns 204
- [ ] `DELETE /api/tasks/:id` returns 404 for non-existent ID

### Task Statistics
- [ ] `GET /api/tasks/stats` returns counts by status: `{ todo: N, in_progress: N, done: N, total: N }`
- [ ] Stats reflect the current state after creates/updates/deletes

### Validation
- [ ] Status field only accepts "todo", "in_progress", "done"
- [ ] Description is optional and can be omitted
- [ ] DueDate is optional but must be a valid ISO date if provided

## Frontend Verification

These can be verified by manual inspection or automated tests:

- [ ] Frontend loads in a browser and displays the task list
- [ ] Creating a task through the form adds it to the list without page reload
- [ ] Editing a task updates it in the list
- [ ] Deleting a task removes it from the list
- [ ] Status filter buttons work (All / To Do / In Progress / Done)
- [ ] Task statistics are displayed and update in real-time

## Project Structure
- [ ] `package.json` exists with appropriate scripts (`start`, `test`, `dev`)
- [ ] TypeScript compiles without errors
- [ ] All tests pass with `npm test` (or equivalent)
- [ ] Server starts with `npm start` (or equivalent)
