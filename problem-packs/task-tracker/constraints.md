# Constraints

- **No database**: Use in-memory storage only. Data loss on server restart is acceptable.
- **No frontend framework**: Use vanilla HTML, CSS, and JavaScript. No React, Vue, Angular, etc.
- **TypeScript for backend**: The backend must be written in TypeScript. Frontend can be plain JavaScript.
- **Standard npm packages only**: Express, cors, uuid, and their type definitions are fine. Avoid heavy ORMs or utility libraries.
- **Port 3000**: The backend server must run on port 3000.
- **Static file serving**: Express should serve the frontend files from a `public/` directory.
- **Single repo**: Backend and frontend live in the same repository.
