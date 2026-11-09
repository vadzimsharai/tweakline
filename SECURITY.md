# Security

## Trust model

- **The server is trusted by its owner.** You run it yourself, and it can read chats, notes and screenshots of the sessions it holds. Do not share one server between people who do not trust each other.
- **Tokens.** Device, session and MCP tokens are 256-bit random values. The server stores only their SHA-256 hashes. `tweakline token new` also writes the MCP token in plain text to `~/.config/tweakline/config.json` (mode 600) for `tweakline mcp`, and the browser keeps its device token in the extension's storage. Revoking a browser or a session kills all of its addresses and deletes the session's files.
- **Page actions need grants.** A session address only lets an AI talk to the person. Reading or changing a page needs access the person granted in chat. The extension checks the grant itself before every action, so a server cannot act beyond it. A grant has a scope and a time:
  - **This tab**: the tab it was given on, tied to the origin (scheme, host and port) that tab showed when the grant was given; on any other origin the grant does not apply. It never outlives the session.
  - **This page**: that exact URL, without the `#` part. **Whole site**: every page of that host, on every scheme and port: a grant for `example.com` also covers `http://example.com:8080`. **Pattern**: every URL the regular expression matches as a whole, from the first character to the last; `example\.com` alone does not match `https://evil.test/?example.com`.
  - **Time**: 1, 8 or 24 hours, or "Forever" (until revoked). These grants belong to the one session they were given in.
  - **Every session**: the page, site or pattern grant applies to **every session of every server paired with this browser**, now and later, until you revoke it in "AI access". Any AI connected to any of those servers can then act inside that scope without asking. Use it only for sites you are comfortable letting every connected AI change.
- **JS patches need approval on each device.** A JavaScript patch runs only after the person confirms it with its code shown, on every device it syncs to. CSS patches apply directly.
- **Page content is untrusted.** The instructions served to AIs say that only chat messages from the person are requests.
- **Pairing rate limit.** More than ten wrong pair codes a minute from one client address are refused. The client address is the TCP peer. Only a proxy in front of the server may name another client with `X-Forwarded-For`: with `--domain`, a proxy on this machine (loopback); with `--trust-proxy`, a proxy on a private network too (10/8, 172.16/12, 192.168/16, fc00::/7), as in the example `relay/compose.yml`, where the proxy reaches the container through the Docker bridge. Use `--trust-proxy` only when nothing else on those networks can reach the server's port directly, since any such host could pick its own address.
- **Open addresses.** Connecting to a server that is neither `https` nor on this machine needs an explicit confirmation in the extension.
- **Pairing needs JSON.** `POST /pair` answers 415 unless the content type is `application/json`, so a web page cannot send it without a CORS preflight.

## Extension permissions

- **`debugger`** attaches the Chrome DevTools protocol to one tab for one action: a screenshot of a tab that is not in front, screen video, and the AI's JavaScript when user scripts are off. While it is attached, Chrome shows a bar "Tweakline started debugging this browser". It runs only for actions the person's grant allows, or that the person started.
- **`userScripts`** runs the AI's JavaScript in the page's own world, after the grant check. It works only after **Allow User Scripts** is turned on for the extension; otherwise `debugger` is used.
- **`<all_urls>`** lets the extension draw notes and the chat on any page. Page actions still need a grant.

## Limits

The server bounds what one session can store, so one AI or browser cannot fill the disk or make the server slow:

- A message text is at most 256 K characters, and one event at most 1 MB as stored. `ask`, notes and patches have a depth and size limit too. Larger requests answer 400 or 413 and change nothing.
- A session keeps at most 8 MB and 2000 events; the oldest go first.
- A file is at most 10 MB. A session keeps at most 200 files or 200 MB; the oldest go first. Files are deleted after 7 days or when the session or its browser is revoked.
- Request bodies over the limit answer 413, and the server closes the connection.
- A browser socket may send only a few KB before it proves its device token, and at most 32 such sockets wait at once.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: [Security advisories](https://github.com/vadzimsharai/tweakline/security/advisories/new). Do not open a public issue. Include the version, steps to reproduce and the impact you see.
