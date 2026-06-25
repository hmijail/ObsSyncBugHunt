// Host connectivity probe: a bare TCP connect to a public DNS resolver. Used to tell
// a genuine Obsidian Sync failure apart from a plain host-internet outage — if the
// host itself can't reach the internet, a container's sync stall is not Obsidian's
// fault, so we shouldn't record it as a Sync timeout (or, worse, data loss).

import net from "node:net";

export function hostOnline(host = "8.8.8.8", port = 53, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}
