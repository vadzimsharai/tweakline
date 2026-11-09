# Contributing

## Layout

- `extension/` Chrome/Chromium extension, Manifest V3, plain JavaScript without a bundler. Load it unpacked from `chrome://extensions` with "Developer mode" on.
- `relay/` the Node server and CLI (`cli.mjs`), bundled into one file by `build.mjs`. `protocol.mjs` holds the limits and payload schemas shared by the HTTP, MCP and browser surfaces; `SECURITY.md` lists the limits, keep it in sync. `instructions.md` is what the server serves to AIs, keep it in sync with the API.
- `skill/tweakline/` the AI skill and its `bin/tweakline` wrapper.

## Setup

Node.js 22 or newer.

```bash
cd relay && npm ci
cd ../extension && npm ci
```

## Tests

```bash
cd relay && npm test                 # server, CLI, MCP and the built bundle
cd extension && npm test             # unit tests
cd extension && npm run e2e          # real Chromium with touch, about 7 minutes
```

The e2e tests need `relay/node_modules` and a Chromium: run `npm run e2e:install` once, or point `CHROMIUM_PATH` at an existing Chromium binary.

## Build and pack

```bash
cd relay && npm run build            # relay/dist/tweakline.cjs, released as tweakline-server.js
node relay/cli.mjs pack              # prints the path of tweakline-extension.zip
```

`pack` leaves out tests, `node_modules` and `package*.json`.

## Behind a proxy

`tweakline serve --domain D` trusts `X-Forwarded-For` for the pairing rate limit only from a proxy on the same machine. When the proxy reaches the server over a private network, such as the Docker bridge in `relay/compose.yml`, add `--trust-proxy`; see `SECURITY.md`.

## Pull requests

Keep changes focused, add or update tests, and make sure the unit tests pass. Change `relay/instructions.md` and `skill/tweakline/SKILL.md` together with the API they describe.

## Releases

1. Set the same version in `relay/package.json` (then `npm install --package-lock-only`), `extension/package.json` and `extension/manifest.json`.
2. Add a `## <version> - <date>` section to `CHANGELOG.md`. It becomes the release notes, so write it for people who use Tweakline.
3. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.

The `release` workflow runs the unit and e2e tests, then builds `tweakline-server.js`, `tweakline-extension.zip` and `tweakline-skill.zip` and attaches them to the GitHub release for the tag. `node tweakline-server.js update` downloads `tweakline-server.js` from the latest release.
