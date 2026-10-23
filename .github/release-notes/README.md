# Release Notes

Each published `vX.Y.Z` tag must have a matching `.github/release-notes/vX.Y.Z.md`
file. The publish workflow deliberately requires this file so GitHub Releases
explain user-visible changes, compatibility impact, and verification instead of
only listing commit subjects.

Use these headings when adding a release note:

- `## Highlights`: the most important user-facing outcome.
- `## Fixes`: problems resolved since the previous tag.
- `## Compatibility`: host, provider, or configuration impact.
- `## Verification`: checks run before publishing.
- `## Upgrade`: migration steps, or state that none are required.
