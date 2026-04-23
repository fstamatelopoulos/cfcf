/**
 * Ambient module declarations for asset imports.
 *
 * Bun supports `import ... from "./foo.md" with { type: "text" }` which
 * inlines the file contents as a string at build time. TypeScript doesn't
 * know about this natively -- this declaration file tells the compiler
 * that `.md` imports and JSON imports from the templates directory resolve
 * to string content.
 */

declare module "*.md" {
  const content: string;
  export default content;
}

// Clio ships SQL migrations alongside its TypeScript code. Same
// `with { type: "text" }` pattern as the Markdown templates -- the SQL
// body is inlined into the build as a string.
declare module "*.sql" {
  const content: string;
  export default content;
}

// All template JSON files are imported with `type: "text"` so they arrive
// as strings, not parsed JSON. Declaring a module pattern for the templates
// directory keeps the JSON elsewhere in the codebase behaving normally.
declare module "*/templates/*.json" {
  const content: string;
  export default content;
}
