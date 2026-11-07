# Publication and privacy checklist

This repository is a single-account Workers port. Public source does not make the
hosted deployment a public sign-up service. See [architecture](ARCHITECTURE.md).

## Before publishing a ref

1. Keep deployment identity and credentials in ignored `*.local.jsonc`, runtime
   Secrets, or an external private operator directory. Never commit live domains,
   account/zone IDs, hardware labels, device IDs, raw logs or credential backups.
2. Stage files selectively. Inspect `git diff --cached`, including new docs and
   generated fixtures. `.gitignore` does not remove already committed history.
3. Scan all reachable history and the exact publication tree using a current
   secret scanner. Use fully redacted reports stored outside this repository.
4. Run the isolated [test gates](TESTING.md). Legacy live diagnostics are not proof
   of production security or cross-network TURN connectivity.
5. Preserve upstream and dependency license notices. Identify derivation rather
   than replacing original authorship. See [notices](../THIRD_PARTY_NOTICES.md).
6. If private operational metadata was committed, back up the repository outside
   the publication tree and rewrite history in an isolated clone. Retain author
   metadata only with consent. Review rewritten refs before any force-push.
7. Push the verified refs, rescan, and change visibility only after an explicit
   publication decision. Existing clones, forks and cached objects may retain old
   history; a rewritten branch does not guarantee worldwide erasure. Test direct
   old-SHA access while the repository is still private. GitHub may retain cached
   commits after a force-push; request support review where applicable, or publish
   the sanitized history into a new, unrelated repository. Do not assume support
   will remove ordinary non-sensitive metadata.

## Git-hosted builds

Do not put operator values in tracked build configuration merely to enable CI.
Use scoped dashboard build settings and runtime Secrets, disable untrusted preview
builds, and never print generated configs or auth material. See
[operations](OPERATIONS.md) for Workers Builds and account-wide free-tier limits.

## Scope of checks

Secret scanners cannot prove the absence of all secrets. Domain/device privacy,
license provenance, executable test assertions and deployment side effects require
manual review too. Publishing source is not a security certification.
