# Task Tracker: REST API + Web Frontend

Build a simple task tracker application with a REST API backend and a web frontend. The application manages tasks with titles, descriptions, statuses, and due dates.

## Architecture

Two components:

### Backend (Node.js + Express + TypeScript)
- REST API server on port 3000
- In-memory data store (no database -- use a simple array/map)
- JSON request/response format
- CORS enabled for frontend communication

### Frontend (HTML + CSS + vanilla JavaScript)
- Single-page application served as static files
- Communicates with the backend API via fetch()
- Responsive layout that works on mobile and desktop
- No framework required -- vanilla HTML/CSS/JS is fine

## API Endpoints

```
GET    /api/tasks              - List all tasks (supports ?status=todo|in_progress|done filter)
POST   /api/tasks              - Create a new task
GET    /api/tasks/:id          - Get a single task
PUT    /api/tasks/:id          - Update a task
DELETE /api/tasks/:id          - Delete a task
GET    /api/tasks/stats        - Get task statistics (count by status)
```

## Task Schema

```json
{
  "id": "uuid-string",
  "title": "string (required, 1-200 chars)",
  "description": "string (optional, max 2000 chars)",
  "status": "todo | in_progress | done",
  "dueDate": "ISO date string (optional)",
  "createdAt": "ISO datetime string",
  "updatedAt": "ISO datetime string"
}
```

## Frontend Features

- View all tasks in a list/card layout
- Create new tasks via a form
- Edit existing tasks (inline or modal)
- Delete tasks with confirmation
- Filter tasks by status (All / To Do / In Progress / Done)
- Show task statistics (count per status)
- Visual indication of overdue tasks (past due date)

## Existing Context

This is a blank project. There is no existing code, no package.json, nothing.
The developer must set up the project from scratch.
