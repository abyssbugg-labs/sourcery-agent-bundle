# Releasing @abyssbugg/sourcery

How to cut a release. Publishing is automated: pushing a `v*` tag on `main`
triggers [.github/workflows/publish.yml](../.github/workflows/publish.yml),
which typechecks, tests, builds, then runs
`npm publish --access public --provenance`.

## One-time setup

1. **Create the npm org.** Sign in at [npmjs.com](https://www.npmjs.com) and
   create a free organization named `abyssbugg` (<https://www.npmjs.com/org/create>).
   The package scope `@abyssbugg` requires it. Free (public) orgs are fine;
   the package publishes with `--access public`.
2. **Create a granular access token.** npmjs.com -> Access Tokens ->
   Generate New Token -> Granular Access Token. Grant it:
   - Packages and scopes: read and write on `@abyssbugg/*`
   - Permission to publish new versions and to create new packages in the org
3. **Add the secret.** Repository -> Settings -> Secrets and variables ->
   Actions -> New repository secret: name `NPM_TOKEN`, value = the token.
4. **Enable 2FA** on your npm account (npmjs.com -> Account Settings ->
   Two-Factor Authentication). The org can require 2FA for publishing
   (Org Settings -> Require two-factor authentication).

## Per release

1. Make sure `main` is green on CI and everything you want shipped is merged.
2. Bump the version and create the tag in one step (from the repo root):

   ```sh
   npm version patch   # or minor / major
   git push --follow-tags
   ```

   `npm version` updates `package.json`, commits, and tags (`v0.2.1` style).
   The tag **must point at a commit on `main`** — the publish workflow refuses
   to publish otherwise.
3. The publish workflow runs automatically: typecheck, test, build,
   `npm publish --access public --provenance`. Provenance requires
   `id-token: write` (already set) and a public repository.
4. Verify on npmjs.com: the package page
   (<https://www.npmjs.com/package/@abyssbugg/sourcery>) should show the new
   version and a "Provenance" badge.
5. Optionally create a GitHub Release from the tag for changelog notes.

## Notes

- `--access public` is required for scoped packages (`@abyssbugg/...`);
  the workflow already passes it.
- The package is `"private": true` in `package.json` to prevent accidental
  local publishes; the workflow runs `npm pkg delete private` in CI only.
- The tag guard means tags created on feature branches will not publish.

## Optional follow-up

- Register the server in the official MCP registry
  (<https://registry.modelcontextprotocol.io>) once the npm package is live,
  so MCP clients can discover it. See the
  [MCP registry docs](https://github.com/modelcontextprotocol/registry) for
  the server submission process.
