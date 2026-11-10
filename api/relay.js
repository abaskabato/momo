// Vercel function when the repo root is the project root. The site itself
// lives in apps/web (which also deploys on its own with Root Directory = apps/web).
export { GET, POST } from "../apps/web/api/relay.js";
