import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// Wrapped rather than `toNextJsHandler(auth.handler)`: reading `.handler` off
// the auth instance builds it, and building it connects the database. At module
// scope that happens during `next build`, which is what made every deployment
// fail before it ever served a request.
export const { GET, POST } = toNextJsHandler((request: Request) => auth.handler(request));
