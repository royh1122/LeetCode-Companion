# Security

LeetCode Companion runs on your own computer. The dashboard listens on `127.0.0.1`, and the browser extension sends data only to the dashboard it was paired with, using its own key. There is no hosted service.

**Server mode** ([docs/SERVER_MODE.md](docs/SERVER_MODE.md)) can make the dashboard reachable from your other devices. It has **no login**: whoever can reach the listed addresses can use the dashboard. It is meant only for private networks (Tailscale, a home LAN, a VPN). Exposing it to the public internet is unsupported and unsafe. Pairing identifies and revokes extension installs; it is not access control.

## Reporting a vulnerability

Please report security problems privately, through GitHub's **Report a vulnerability** button on this repository's **Security** tab, not in a public issue. Include the steps to reproduce and what an attacker could do.

Things that count as security problems here include: a web page or another site reaching the dashboard or its data, a page on leetcode.com making the extension do something it shouldn't, a device key or pairing code leaking, the dashboard answering an address that isn't listed in server mode, or anything that could send your code or notes off your computer.

This is a personal project maintained in spare time, so there is no guaranteed response time.
