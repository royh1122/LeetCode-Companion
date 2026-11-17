# Server mode: one dashboard, several devices

By default LeetCode Companion answers only on the computer it runs on (`127.0.0.1`). **Server mode** lets the same dashboard serve your other devices, such as an iPad, a second PC or a phone browser. It works over a **private network**: Tailscale, your home Wi-Fi or a VPN. One database means nothing ever needs merging.

Server mode is off unless you turn it on. When it's off, nothing changes.

## What each device can do

Server mode is built around two kinds of devices:

- **Computers with the extension** (Chrome, Edge, Brave and other Chromium browsers): everything, including automatic capture of your LeetCode submissions. Each one is paired with the dashboard as its own device.
- **Everything else** (an iPad, a phone, a browser without the extension): the dashboard itself. Plan the week, do your reviews, read your history and notes, and log attempts by hand (**Log a submission manually** on the session page, or a past attempt from any question page).

A typical setup: solve on a computer, where submissions are captured, and review or catch up from a tablet.

## Security model: read this first

- **There is no login.** Anyone who can reach the dashboard's address can see and change everything, including your code and notes, and can download a full export. The private network is the lock.
- **Never expose it to the public internet.** That rules out port forwarding on your router, Tailscale Funnel, and a cloud server with an open port. A built-in login may come later; until then, these setups are unsafe.
- **The dashboard only answers to the addresses you list.** A request naming any other host is refused. That still blocks DNS-rebinding tricks from websites.
- **Each browser with the extension is paired separately** and appears under **Settings → Devices**. Pairing tells devices apart and lets you cut one off (**Remove**) without touching the others. It doesn't keep people out: anyone who can open the dashboard can also add a device.
- **Plain `http://` is fine on Tailscale or a VPN**, because they encrypt traffic between your devices. On shared Wi-Fi, prefer Tailscale or HTTPS through Tailscale Serve.

## The settings file

Server mode is read from `server.json` in the data folder (`data/server.json` by default; `LCC_DATA_DIR` moves it). `npm run up` reads it on every start, so restart the dashboard after changing it. **Settings → Server mode** shows what is in effect.

```json
{
  "hosts": ["my-laptop.tailnet-name.ts.net", "my-laptop:4317"],
  "listen": "loopback"
}
```

- **`hosts`**: the addresses other devices type to reach the dashboard. Write `name` to accept any port, or `name:port` for one port only. Use names or IP addresses, not URLs, and no wildcards.
- **`listen`**:
  - `"loopback"` (default): the dashboard still listens only on this computer. Use it when a local proxy such as Tailscale Serve passes requests in.
  - `"network"`: the dashboard listens on all network interfaces. Use it for home Wi-Fi or a tailnet IP without a proxy. It needs at least one entry in `hosts`.

If the file is invalid, the dashboard refuses to start and says why. It never quietly falls back to something else.

The environment variables `LCC_ALLOWED_HOSTS` (a comma-separated list) and `LCC_LISTEN` override the file. Docker uses them.

## Setup recipes

### A. Tailscale Serve (recommended: HTTPS, and the dashboard stays on this computer)

On the computer that runs the dashboard (your laptop, a Pi or a mini PC), with Tailscale installed and signed in:

0. Turn on HTTPS certificates for your tailnet, once: Tailscale admin console → **DNS** → **HTTPS Certificates** → **Enable**. Without them Serve can't offer `https://`. Note that this publishes your machines' tailnet names in public Certificate Transparency logs.
1. Find the machine's tailnet name: `tailscale status`, or the Tailscale admin console. It looks like `my-laptop.tailnet-name.ts.net`.
2. Create `data/server.json`. If Serve uses HTTPS port 443, list the name with no port; if it uses another port, such as 8443, list `name:8443`.
   ```json
   { "hosts": ["my-laptop.tailnet-name.ts.net"], "listen": "loopback" }
   ```
3. Start the dashboard: `npm run up`.
4. Share it on your tailnet: `tailscale serve --bg http://127.0.0.1:4317`. Check what is already served first with `tailscale serve status`. To use another HTTPS port, add `--https=8443`. The very first request can take half a minute while Tailscale fetches the certificate.
5. On another device in your tailnet, open `https://my-laptop.tailnet-name.ts.net`.

To stop sharing, run `tailscale serve --https=443 off` (or the port you used).

*Status: verified 2026-11-17 with Tailscale 1.104 on Windows (`--https=8443`, `hosts` listing the name without a port): from an iPad in Safari, pages, navigation and changes (server actions, including Add a device) worked. Pairing by code, using the device key, and removing the device were checked through the same address from the laptop.*

### B. Home Wi-Fi (or a tailnet IP) without a proxy

1. Find the computer's address on your network, for example `192.168.1.20` (`ipconfig` on Windows, `ip addr` on Linux).
2. Create `data/server.json`:
   ```json
   { "hosts": ["192.168.1.20:4317"], "listen": "network" }
   ```
3. Run `npm run up` and allow Node.js through the firewall for **private** networks only if your OS asks.
4. On another device on the same Wi-Fi, open `http://192.168.1.20:4317`.

Home routers often hand out new addresses. Reserve one for this computer in the router, or use Tailscale.

### C. Docker on an always-on machine or a small server

The repository has a `Dockerfile` and an example `compose.yaml`. The example puts the dashboard on your tailnet through a Tailscale container and publishes no port. Set `LCC_ALLOWED_HOSTS` to the tailnet name and port. Your data lives in the `lcc-data` volume (backups are in its `backups/` folder).

```bash
echo "TS_AUTHKEY=tskey-auth-..." > .env    # from the Tailscale admin console
# edit compose.yaml: replace tailnet-name
docker compose up -d
```

The image contains the dashboard only. Build the extension on each computer that uses it (`npm run ext:build`).

*Status: the image has not been built by the project's tests yet. The commands it runs (install, build, migrate, start on all interfaces with an allowed host) are checked on Linux.*

## Pairing a device

Pairing is for computers with the extension (see [What each device can do](#what-each-device-can-do)). On the computer you want to add:

1. Install the extension in a Chromium browser (Chrome, Edge, Brave and others): `npm run ext:build`, then **Load unpacked** `apps/extension/dist` at `chrome://extensions`.
2. In the dashboard (opened from any device), go to **Settings → Devices → Add a device**. It shows a line like `https://my-laptop.tailnet-name.ts.net  K7Q4-MX2P`.
3. Open the extension's **options** and paste that line, or type the address and code separately. Click **Pair & test connection**.
4. When the address isn't this computer, the browser asks for permission to reach it. Allow it.

The code works once, for 10 minutes, and stops working after 5 wrong tries. The device appears in **Settings → Devices** under a name like "Edge on Windows", which you can change there.

## Removing a device

**Settings → Devices → Remove.** That browser's extension stops syncing at once, and its side panel asks you to pair again. Everything it already synced stays. Anything it captured while removed stays queued and syncs after you pair it again.

## Backups and moving

Server mode doesn't change where data lives. It is the same SQLite file, with the same automatic backups before migrations and imports. See the README's data section.
