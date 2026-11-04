# Releasing

A release is a git tag `vMAJOR.MINOR.PATCH` pushed to GitHub. The `release` workflow (`.github/workflows/release.yml`) does the rest. Nothing is published to a package registry.

## Cut a release

1. On `main` with a green CI, set the new version and commit it:

   ```sh
   npm version 0.2.0 --no-git-tag-version   # updates package.json and package-lock.json
   git commit -am "Release 0.2.0"
   ```

2. Tag that commit and push the tag:

   ```sh
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin main v0.2.0
   ```

The workflow runs only for a pushed tag that starts with `v`. It stops before building anything unless

- the tag is exactly `v` plus the version in the manifest (`scripts/check-release-tag.sh`), and
- the tagged commit is in the history of the default branch.

Then the `verify` job repeats what CI does (install without lifecycle scripts or with `--locked`, lint/typecheck, tests, build), and the `release` job builds the files, writes `SHA256SUMS`, creates a build-provenance attestation for them and creates the GitHub release with the built-in `GITHUB_TOKEN` (no other secret is involved). The release notes are the subjects of the commits since the previous tag (`scripts/release-notes.sh`). A tag with a `-` in it (`v0.2.0-rc.1`) is marked as a pre-release.

To try the build without releasing anything, run the `release` workflow by hand (Actions, release, Run workflow). A manual run builds the files and keeps them as a workflow artifact for seven days; it never creates a release or an attestation.

## What a release contains

- `agent-guardrails-VERSION.tgz`: the output of `npm pack` after a build, that is the package exactly as `npm` would publish it (the `files` list of `package.json`).
- `SHA256SUMS`: the SHA-256 of every file above.

## Verify a download

Download the files and `SHA256SUMS` from the release page, then:

```sh
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS
gh attestation verify FILE --repo kienpt91/agent-guardrails
```

The checksum only shows that the file is the one listed. `gh attestation verify` checks the signed provenance statement that GitHub recorded when the workflow built the file: that it was produced by this repository's `release` workflow, from the tagged commit. Do both. (Attestations are available for public repositories.)

## Publishing to a registry later

This is a deliberate manual step and is not wired up, because it needs a long-lived secret and a decision about the name on the registry.

To publish to npm: create a granular npm access token that is limited to publishing this one package, store it as a repository secret (for example `NPM_TOKEN`), and add a job to `release.yml` that `needs: release`, runs in a GitHub environment that requires your approval, has only `contents: read` and `id-token: write`, and runs `npm publish --provenance --access public` with `NODE_AUTH_TOKEN` set from the secret. Pin and review any action you add the same way the existing ones are (full commit SHA).
