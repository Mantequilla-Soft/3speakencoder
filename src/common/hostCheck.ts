import { isIP } from 'net';
import { hostname } from 'os';

/**
 * DNS rebinding defense for the dashboard.
 *
 * A malicious page can point its own domain at this machine (DNS rebinding); the
 * browser then treats requests to evil.example:3001 as same-origin and sends any
 * header. Those requests still carry `Host: evil.example:3001`, so only accept
 * names an attacker can't control: IP literals, localhost, this machine's own
 * name, and names the operator lists in DASHBOARD_ALLOWED_HOSTS.
 */
export function createHostCheck(extraHosts: string[] = []): (hostHeader: string | undefined) => boolean {
  const own = hostname().toLowerCase();
  const allowed = new Set(['localhost', own, `${own}.local`, ...extraHosts.map(h => h.trim().toLowerCase()).filter(Boolean)]);

  return (hostHeader) => {
    const name = hostnameOf(hostHeader);
    if (!name) return false;
    return isIP(name) !== 0 || name.endsWith('.localhost') || allowed.has(name);
  };
}

/** A browser's Origin, when sent, must be this same host (scheme + host + port). */
export function originMatchesHost(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true; // curl, scripts, same-origin GET navigations
  try {
    return new URL(origin).host === hostHeader?.toLowerCase();
  } catch {
    return false; // includes Origin: null (sandboxed iframes, file://)
  }
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    // URL handles "host:port" and "[::1]:port"; strip IPv6 brackets for isIP()
    return new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  } catch {
    return null;
  }
}
