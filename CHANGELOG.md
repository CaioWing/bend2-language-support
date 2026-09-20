# Changelog

## 0.1.2

- Replace Bend's location-free `N TODOs found` output with actionable proof-obligation diagnostics.
- Point each open law at its declaration when `LAWS.bend` is checked without a usable proof companion.
- Explain whether `PROOF.bend` participated in a check with unresolved proof holes.

## 0.1.1

- Check an open `LAWS.bend` through a sibling `PROOF.bend`, preserving the intended separation between claims and proofs.
- Use unsaved companion proof contents when `PROOF.bend` is open.
- Replace generated temporary module names in compiler diagnostics with `LAWS` and `PROOF`.

## 0.1.0

- Add Bend 2 syntax highlighting and editor configuration.
- Add compiler-backed diagnostics without executing `main`.
- Add configurable checks on open, save, and after typing.
- Add completions, hover help, Go to Definition, and document symbols.
- Add Bend 2 snippets and check, run, and Base documentation commands.
