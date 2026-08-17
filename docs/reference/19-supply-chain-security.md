# Supply-Chain Security

This chapter is the focused design for AI-DLC release production,
publication, verification, installation, and update transport. It describes
the controls implemented in `.github/workflows/release.yml`,
`scripts/package-release.ts`, `core/tools/aidlc-release.ts`, and the native
installer and lifecycle modules.

## 1. Complementary release controls

Three controls answer different questions:

1. **Release attestation.** GitHub artifact attestation verification proves
   that an artifact digest has an attestation issued for
   `awslabs/aidlc-workflows` by the release workflow. The protected-tag and
   immutable-release policy binds those attested bytes to one release record.
2. **SLSA build provenance.** The signed provenance predicate records the
   source repository, source revision, GitHub Actions workflow, and build
   environment that produced the subject digest. It answers how and from what
   source the artifact was built.
3. **Checksums.** `checksums.txt` proves that downloaded bytes match the
   SHA-256 values published for `version.json` and each manifest asset. It is
   the byte-integrity control used directly by installers and mirrors.

The controls are complementary. A checksum without authenticated provenance
can faithfully reproduce an attacker's bytes. Provenance without a local
digest check does not prove the file on disk is the attested subject.

## 2. Publication boundary

The publication boundary is one GitHub Release for an existing `v*` tag. The
workflow starts from either a protected tag pushed from a reviewed release-prep
commit or a manual dispatch naming an existing tag. `gh release create` uses
`--verify-tag`; the publish job also requires the tag to equal
`v<version.json.version>` before it can continue
(`.github/workflows/release.yml`).

Published releases are immutable by policy. A defective artifact is corrected
by a new patch release. A compromised release is excluded from update
discovery and linked to its corrective release without deleting the original
release, tag, attestations, or audit record.

`scripts/package-release.ts` stages `version.json` and `checksums.txt` before
the publish job attests `build/release/*`. The workflow then copies the
Sigstore bundle to the stable asset name
`aidlc-release.intoto.jsonl` and creates the release. The bundle is
intentionally not listed in either `version.json` or `checksums.txt`: those
files describe and digest the installable artifacts, while the bundle is its
own trust channel and is verified with Sigstore or `gh attestation verify`.

## 3. Threat model

### Build tampering

The build job uses commit-SHA-pinned third-party actions, installs the frozen
`bun.lock`, runs the projection drift guard, and builds each target in a
target-native matrix (`.github/workflows/release.yml`). The candidate is
assembled once by `scripts/package-release.ts`, then consumed unchanged by
Unix and Windows lifecycle tests before publication. GitHub artifact
attestations provide the signed SLSA provenance for the staged digests.

### Release or tag hijack

Tag protection is a required repository setting. It is not represented by a
file in this repository and is not yet confirmed as applied. The release job
uses `gh release create --verify-tag`, and the tag/version equality check
compares the selected tag with `version.json.version` before attestation or
publication (`.github/workflows/release.yml`).

### Mirror or download tampering

The publish job runs `sha256sum -c checksums.txt` immediately before
attestation. `core/tools/aidlc-release.ts` verifies the `version.json` checksum
before trusting manifest fields, then verifies each selected asset against
both the manifest and checksum row. Asset names are basename-only and metadata
and asset sizes are bounded. Mirrors carry the complete manifest-driven asset
set plus `aidlc-release.intoto.jsonl`, allowing independent provenance
verification.

### Partial publication failure

Publication has no destructive automatic rollback. The named publication
owner must inspect the GitHub Release, prevent an incomplete release from
remaining in latest/update discovery, preserve the failed record for audit,
and publish a complete corrective patch release. The owner assignment is a
focused-review decision in section 7.

### Compromised release

The response owner excludes the compromised version from update discovery,
publishes a corrective patch from a reviewed commit and protected tag, and
links both release records. Existing records are retained so tags,
attestations, and incident evidence remain auditable.

### Archive tampering at install time

`core/tools/aidlc-archive.ts` rejects absolute paths, traversal segments,
drive-root paths, links, special files, duplicate destinations, file-ancestor
collisions, bad tar checksums, truncation, and oversized compressed or
expanded input. `core/tools/aidlc-lifecycle.ts` extracts only into a private
temporary candidate and reserves the verified executable names before the
candidate can reach the install root.

The Unix bootstrap refuses root by default (`scripts/install.sh`); the
PowerShell bootstrap refuses Administrator by default unless the explicit CI
escape hatch is set (`scripts/install.ps1`). Installs are per-user.
`core/tools/aidlc-transaction.ts` is the shared mutation engine: it validates
root-relative non-overlapping operations, blocks symlink traversal and
filesystem-boundary crossings, stages candidates privately, snapshots current
targets, commits with rename boundaries, rolls back in reverse order, and
retains incomplete recovery evidence in `.aidlc-recovery-*` quarantine.

## 4. SLSA level

The initial claim is **SLSA Build Level 2**. GitHub Actions produces signed
artifact attestations for release subjects, and consumers can verify the
source and build identity. The stated goal is **SLSA Build Level 3**, using an
isolated, organization-controlled reusable build workflow. Level 3 is not
implemented.

## 5. Consumer verification

Online verification against GitHub:

```bash
gh attestation verify ./aidlc-linux-x64 \
  --repo awslabs/aidlc-workflows
```

Offline or mirror verification from the shipped bundle:

```bash
gh attestation verify ./aidlc-linux-x64 \
  --bundle ./aidlc-release.intoto.jsonl \
  --repo awslabs/aidlc-workflows
```

Verify every artifact covered by the checksum file:

```bash
sha256sum -c checksums.txt
```

`scripts/package-release.ts` writes the schema consumed by mirrors and
installers. `version.json` contains:

- `schemaVersion`
- `version`
- `date`
- `distributions[]` with `name` and `productName`
- `assets[]` with `name`, `sha256`, `bytes`, and `kind`
- binary-only `target`
- optional binary `verification` with `status`, `mode`, and `hostTarget`

`core/tools/aidlc-release.ts` validates those exact fields, rejects unknown
asset shapes, and requires the runtime and installer names defined by the
schema.

## 6. Workflow hardening inventory

- Every third-party action in `.github/workflows/release.yml` is pinned to a
  full 40-hex commit SHA, with the release line retained as a comment.
- Workflow-global permissions are `contents: read`.
- Only the publish job receives `contents: write`, `id-token: write`, and
  `attestations: write`.
- OIDC supplies short-lived identity to Sigstore; no long-lived signing key is
  stored in the repository.
- The release tag must be protected and must point to the reviewed
  release-prep commit. Tag protection is a required repository setting.
- `alpine:3.20` remains tag-pinned for the musl smoke job. It mounts the
  workspace read-only, executes an already-built binary only, and produces no
  release bytes. Artifact-moving and source-fetching actions are SHA-pinned.

## 7. Named ownership

Ownership is team-based, not individual. Every duty below requires elevated
repository rights (release editing, tag pushes through protection,
workflow-adjacent changes), and `@awslabs/aidlc-admins` is the team that
holds them - consistent with the CODEOWNERS policy already in force, which
assigns `CHANGELOG.md` and `.github/` to that team alone. Naming the team
rather than individuals keeps this table valid across membership rotation.
The focused review confirms the assignment and the qualifiers below.

| Duty | Owner |
|------|-------|
| Approve the release-prep PR | `@awslabs/aidlc-admins` |
| Authorize the protected tag | `@awslabs/aidlc-admins` |
| Publish the GitHub Release | `@awslabs/aidlc-admins` |
| Update latest and installer metadata | `@awslabs/aidlc-admins` |
| Respond to partial publication failure | `@awslabs/aidlc-admins` |
| Supersede a compromised release | `@awslabs/aidlc-admins` |

Two qualifiers carry the separation-of-duties intent that individual names
would otherwise have encoded:

- The release-prep PR must be approved by a team member other than its
  author. GitHub enforces this mechanically: an author cannot approve their
  own pull request.
- A compromised release must be superseded by a team member other than the
  one who authorized the affected tag, because the compromise vector may be
  that member's credentials.

The tag-protection ruleset's allowlist names the same team, so the setting
itself enforces who can authorize a release tag, and membership rotation
never requires touching the ruleset. The GitHub Release is published by the
tag-triggered workflow; the team owns that outcome, and the first responder
for a publication failure is by convention the member who authorized the
tag, though any member may act.

## 8. No OS code-signing

AI-DLC does not use Apple Developer ID, notarization, Authenticode, or another
OS code-signing program, and does not plan to add one.

The supported macOS path downloads through `curl`, which does not add the
browser quarantine attribute. Apple Silicon linkers apply the automatic ad
hoc signature needed for a local Mach-O executable. On Windows,
`scripts/install.ps1` verifies the SHA-256 and byte length, then calls
`Unblock-File` to remove Mark-of-the-Web before executing the verified
binary; this is the supported SmartScreen path.

Two carve-outs are accepted:

- A raw binary downloaded through a browser can carry macOS quarantine. The
  documentation never offers that path; use the installer or offline release
  set.
- Device-management environments that require organization-signed binaries
  are not a supported audience. They can ingest the offline release set,
  perform internal review, and redistribute it under their own controls.

## 9. Enterprise transport

The native client in `core/tools/aidlc-release.ts` reads `HTTPS_PROXY` or
`https_proxy` and applies `NO_PROXY` or `no_proxy`. It deliberately does not
read `HTTP_PROXY`. Without a custom CA it uses the platform trust store; an
absolute `ca-bundle` path can be supplied by option, `AIDLC_CA_BUNDLE`, or
machine config (`core/tools/aidlc-machine-config.ts`).

Release mirrors resolve in explicit option, `AIDLC_RELEASE_BASE_URL`, machine
`release-base-url`, then the GitHub default. Mirror URLs must use HTTPS except
for loopback tests and cannot contain credentials, queries, or fragments.
Proxy credentials stay in the process environment: they are never written to
machine config, logs, or errors. URL errors pass through the redactor in
`core/tools/aidlc-release.ts`.

Offline mode is first-class: `--offline` requires a local `--from` release
directory and opens no release socket. `core/tools/aidlc-update.ts` caches
update metadata for 24 hours in `update-check.json` and replaces it through
the shared transaction engine. Global `update-check=false` disables automatic
and explicit metadata refresh, but does not block a user-requested
`aidlc update`.

## 10. Standing trust rules

1. An arbitrary plugin URL is never an automatic trust source. Claude and
   Codex use host-native marketplace and trust flows; Kiro folder-drop is an
   explicit operator trust decision. AIDLC does not fetch and execute a plugin
   solely because content named a URL (`docs/reference/18-plugin-mechanism.md`).
2. Authored content is never forked per release channel. `core/` and
   `harness/<name>/` are the hand-authored sources, and `scripts/package.ts`
   generates both `dist/` and `dist-release/`. The drift guard requires both
   channels to match those sources (`docs/reference/01-architecture.md`).

## 11. Open items for focused review

- Apply and verify the protected-tag repository setting, with its allowlist
  naming `@awslabs/aidlc-admins` per section 7.
- Confirm the team-based ownership assignment in section 7
  (`@awslabs/aidlc-admins` on every duty, with its two separation-of-duties
  qualifiers).
- Build the isolated organization-controlled workflow required for SLSA Build
  Level 3.
- Resolve the Windows verification policy. The current implementation marks a
  host-runnable windows-x64 artifact `VERIFIED` after its full-runtime gates
  pass (`scripts/build-binaries.ts`). The RFC proposed retaining
  `UNVERIFIED` until milestone 3 Windows journeys are green; that hold is not
  implemented, so the review must decide whether the current Windows gates
  satisfy the milestone or whether the label policy must change.
