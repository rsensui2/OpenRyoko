/** Header a session-scoped MCP caller stamps its own session id into, so a
 *  gateway route can attribute the request (upstream-compatible name). */
export const CALLER_SESSION_HEADER = "x-jinn-caller-session";
