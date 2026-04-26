// Stub for the `server-only` package in test runs. Vitest's node environment
// doesn't satisfy the React Server Components export condition that the real
// package guards on, so importing it throws. This file intentionally exports
// nothing — it just lets `import "server-only"` resolve to a no-op module.
export {};
