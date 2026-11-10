# Changelog

## 0.1.1 - 2026-11-10

**Live edits**
- CSS and JavaScript from the AI now work in browsers that accept the injection but do nothing with it, as Vivaldi on Android did: they used to answer "applied" while the page stayed the same.
- `css` reads its effect back from the page. When the browser ignores the injected style, the CSS goes into a stylesheet on the page instead; the answer says which way it took (`"via":"user"` or `"via":"sheet"`), and `undo` removes either.
- `js` counts as run only when the code itself reports that it started. When user scripts are off or silent, the code runs in the page's own world through `scripting`, and through `debugger` only when the page's Content-Security-Policy forbids `eval`.
- Saved CSS patches take the same way, so they apply on those browsers too.
- When nothing works, the answer is an error with the reason, never "applied".

## 0.1.0 - 2026-11-09

First public release.

**Notes and chat**
- Arrows, points and boxes with captions on any page. They go to the AI with two screenshots: the clean page and the page with the notes.
- A chat with your own AI next to the page: docked to the side or bottom, a small window or full screen. Files, several chats per session, edits of your own messages.
- Screenshots and screen video in a gallery, ready to send to the chat.

**Live edits**
- The AI reads the page, clicks, types, takes screenshots and changes CSS or JS while you watch. Every step can be undone.
- Access is asked in the chat and checked in the browser: this tab, page, site or a URL pattern, for 1, 8 or 24 hours or until you revoke it.

**Patches**
- The AI offers a change it made as a **Save patch** button in the chat, with a before and after preview.
- A patch works on a page, a section, a whole site or a URL pattern, applies when the page opens, and syncs between your devices.
- JavaScript in a patch runs only after you allow its exact code on that device.

**Server and AI**
- `tweakline-server.js`: one file for Node.js 22+. Pairs browsers, keeps sessions, chats and files, and updates itself with `node tweakline-server.js update`.
- Connect any agent by session address (plain HTTP, works with `curl`) or by MCP (stdio or HTTP).
- `tweakline` skill for Claude Code and other agents: install, connect and run.
