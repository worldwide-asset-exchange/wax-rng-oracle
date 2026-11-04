# Releasing wax-rng-oracle

This is the release procedure for the maintainers. This GitHub repository is the primary repository:
the production container image is built here, by `.github/workflows/release.yml`.

## In short

A release is an annotated, unprefixed tag `X.Y.Z` on `main` (for example `7.2.1`). The tag starts
the `release` workflow, which tests the code, waits for a maintainer's approval, then builds the
image and pushes it as `vX.Y.Z`. **Nothing deploys by itself.** The maintainers deploy the new image
to the signing members **one member at a time**.

> **Why one at a time.** `orng.wax` is a 2-of-3 threshold signer. Two members must keep signing
> while the third restarts. A member with a wrong share or share index stops at boot (fail closed).
> If all three restarted on a bad image together, random numbers would stop for every dapp.

## Steps

1. **Merge the change into `main` by pull request.** CI (`ci.yml`) runs the floors, lint, unit and
   integration tests. Run the same checks locally first:

   ```bash
   npm ci
   npm run check:deps && npm run lint && npm run test:unit
   ```

2. **Choose the version** and set it in `package.json` `version` in the same pull request. `/version`
   reports it, and the tag must equal it.
3. **Record the change** in `CHANGELOG.md` and in `release-notes/X.Y.Z.md` (sections `## What
   changed`, `## Why`, and the deployment notes if the change needs any).
4. **Create and push the annotated tag** on the head of `main`:

   ```bash
   git checkout main && git pull
   git tag -a X.Y.Z -m X.Y.Z
   git push origin X.Y.Z
   ```

   Only repository admins can create tags. Tags cannot be moved or deleted. If a release is wrong,
   make a new version.
5. **Approve the image job.** The `verify` job runs first (tag = version, floors, lint, unit tests).
   The `image` job then waits for approval in the `production` environment. Approve it only when
   the tag's commit is the `main` commit you mean to release. The job also stops if the commit is
   not on `main`, or if the image tag already exists.
6. **Copy the digest** from the run summary.
7. **Roll member 1.** Pin the digest for the first member only, and wait until its pod runs it.
8. **Verify member 1** (next section). Do not continue until every check passes.
9. **Roll and verify member 2, then member 3**, the same way.

## Verify a member — by effect, never by pipeline status

Run all of these for the member you just rolled (`<port>` is its health API port, 3000 by default):

1. The member runs the new image digest (read it from the running pod, not from the deployment spec).
2. The boot self-check passed. The log has:
   `Boot self-check passed: <account> share index <N> is consistent with on-chain pubkeys[…] and oracles.a`
3. `GET /health-check` returns `200` and `"bootCheck": {"ok": true, …}`, and `GET /version` returns
   the new version.
4. On chain, the member's account submits `submitpart` at the same rate as the other two members, and
   has at least one `setrand` (a combine that used its partial succeeded). For example, from a public
   Hyperion:

   ```bash
   curl -s "https://wax.eosusa.io/v2/history/get_actions?account=orng.wax&act.name=submitpart&after=<roll-time>&limit=1000" \
     | python3 -c 'import sys,json,collections;a=json.load(sys.stdin)["actions"];print(collections.Counter(x["act"]["authorization"][0]["actor"] for x in a))'
   # repeat with act.name=setrand
   ```

5. No `ERROR` lines after the first seconds of boot. At boot a member retries old deliveries, and a
   dapp's contract can refuse them (`Missing authorization for this collection`,
   `dereference of end iterator`). Those lines are not signing failures.

## If something fails

- **`verify` fails:** fix the code by pull request. Do not tag.
- **`image` fails:** nothing was pushed. Fix the cause and release the next version.
- **A member crash-loops with `Boot self-check FAILED: … (<CODE>)`:** that member's share or index
  does not match the chain. The other two still sign. Do not roll another member. Read the failed
  check names (the log never prints values), fix forward, or pin that member back to the previous
  digest.
- **`/health-check` returns 500 with `rpcReachable: false`:** the chain RPC was unreachable at boot.
  The member retries for about a minute, then exits; the restart is the retry.

## Dependencies

Every dependency comes from the public npm registry and is pinned in `package-lock.json`.
`Dockerfile_eks` stops the build if the lockfile names any other source. Do not add a private
registry or an internal package: this repository is public.

## Reference

| item | value |
|---|---|
| Workflow | `.github/workflows/release.yml`: `verify`, then `image` (environment `production`) |
| Tag | unprefixed `X.Y.Z` on `main`; image tag `vX.Y.Z` |
| Image | built from `Dockerfile_eks`; base image pinned by digest; image tags are immutable |
| Repository settings | variables `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REGISTRY`, `ECR_REPOSITORY`; environment `production` with a required reviewer and a tag-only deployment policy; the cloud role trusts only that environment |

## Rules

- Actions in the workflow are pinned to full commit SHAs. Keep them pinned when you update them.
- Change the base image on purpose, in its own release.
- Never roll more than one member at a time.
