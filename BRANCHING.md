# Branching and releases

`develop` is the staging and integration branch. `production` is the live release branch.

## Invariant

`production` must always point to a commit that is already in `develop`. In Git terms:

```bash
git merge-base --is-ancestor origin/production origin/develop
```

That command must exit successfully. Never merge, squash, or rebase a pull request directly into `production`, because GitHub would create commits that are not in `develop`.

## Change flow

1. Create a feature or fix branch from `develop`.
2. Open a pull request into `develop`.
3. Wait for required checks and resolve review conversations.
4. Merge the pull request into `develop`.
5. Verify the staging deployment.
6. Copy the full SHA shown by `git rev-parse origin/develop`.
7. In GitHub Actions, run **Promote develop to production** and enter that exact SHA.

The promotion workflow verifies that the SHA is the current `develop` head and that moving `production` to it is a fast-forward. The protected production branch can be updated only by the workflow's deploy key.

## Hotfixes

Hotfixes follow the same path: branch from `develop`, merge into `develop`, verify staging, then promote. Do not commit or merge directly into `production`.
