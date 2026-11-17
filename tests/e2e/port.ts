/**
 * The end-to-end tests run their own dashboard on a dedicated port, never the real one (4317):
 * the real dashboard can keep running, the tests can't reach real data, and the installed
 * extension (pointed at 4317) doesn't talk to the test server. Override with LCC_E2E_PORT.
 */
export const E2E_PORT = Number(process.env.LCC_E2E_PORT) || 4327;
export const E2E_BASE = `http://127.0.0.1:${E2E_PORT}`;
/**
 * The test server runs in server mode with this extra address. Chrome resolves *.localhost to this
 * computer, but the dashboard treats the name like any other host, so the flows exercise the
 * server-mode path (host allowlist, pairing through a non-loopback address).
 */
export const E2E_SERVER_HOST = `lcc-e2e.localhost:${E2E_PORT}`;
export const E2E_SERVER_BASE = `http://${E2E_SERVER_HOST}`;
