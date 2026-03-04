# Copilot Instructions

## General Guidelines

- When making code changes, always include an entry in `CHANGELOG.md` describing what was changed.
- Follow the existing changelog format: group entries under a version heading with a `### Changed` section.
- Maintain backwards compatibility — do not remove or rename existing exported fields or types.
- Run `npm run build` and `npm test` to verify changes before submitting.
