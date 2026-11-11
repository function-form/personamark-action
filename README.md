# PersonaMark audit

A GitHub Action that audits your site with [PersonaMark](https://personamark.app) after a deploy,
and reports what changed since the audit before: the score, each area's score, and the issues that
are new, back again or fixed. It can also fail the step when the score drops or a high-severity
issue appears.

## Setup

1. In PersonaMark, open your site's **Settings** › **API** and make a key. Only an owner can.
2. In your repository, add the key as an Actions secret named `PERSONAMARK_API_KEY`.
3. Add a step that runs after your production deploy.

### After a Vercel production deploy

```yaml
name: PersonaMark audit

on:
  deployment_status:

jobs:
  audit:
    if: >-
      github.event.deployment_status.state == 'success' &&
      github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    timeout-minutes: 40
    permissions:
      pull-requests: write # comment on the pull request the deployed commit came from
      contents: write # or on the commit, when there's no pull request
    steps:
      - uses: function-form/personamark-action@v1
        with:
          api-key: ${{ secrets.PERSONAMARK_API_KEY }}
          fail-on: new-high
```

### After a release

```yaml
on:
  release:
    types: [published]

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    permissions:
      contents: write # a release's commit usually has no pull request, so it comments there
    steps:
      # Your deploy steps first, then:
      - uses: function-form/personamark-action@v1
        with:
          api-key: ${{ secrets.PERSONAMARK_API_KEY }}
```

The audit covers the site's verified domain as it is when the step runs, so run it once the deploy
is live.

## Inputs

| Input             | Default                        | What it does                                                                                                                       |
| ----------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `api-key`         | (required)                     | The site's API key, from a secret.                                                                                                 |
| `fail-on`         | `none`                         | `new-high` fails when a high-severity issue is new or back; `score-drop:<n>` fails when the score fell by n or more. Comma-separate both. |
| `wait`            | `true`                         | With `false`, the step only starts the audit.                                                                                      |
| `timeout-minutes` | `30`                           | How long to wait for the audit. The audit carries on past it, and the step passes unless `fail-on` asks for something.             |
| `comment`         | `true`                         | Post the summary as a comment too (see below). `false` keeps it to the job summary.                                                |
| `github-token`    | `${{ github.token }}`          | The token to comment with.                                                                                                         |
| `base-url`        | `https://work.personamark.app` | Where PersonaMark is.                                                                                                              |

If an audit is already going when the step starts, it waits for that one instead of starting
another. A key can start 24 audits a day.

## Outputs

`job-id`, `audit-id`, `audit-url`, `score`, `score-change` (empty when the two audits can't be
compared, such as when the scoring rules changed), and `new-high`.

## What it reports

The job summary shows the score and its change, each area, and up to 10 checks each that are new,
back or fixed, with an example page and a link to the audit in PersonaMark. A partial audit, or two
audits scored by different rules, aren't compared, and issues you've marked intended in PersonaMark
never count.

It also posts the summary as a comment where the change's authors will see it: on the pull request
the deployed commit came from, or on the commit itself when no pull request has it. Running again
for the same pull request updates that comment rather than adding another. Commenting needs the
job's `permissions` above; without them the step warns and carries on.

## Development

```sh
pnpm install
pnpm check   # typecheck, test, build, and fail if dist/ is out of date
```

`dist/index.js` is committed, since an action runs from the repository as it is. Release by
pushing a `vX.Y.Z` tag and moving `v1` to it.
