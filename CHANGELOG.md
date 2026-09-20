# Changelog

## 0.3.1

- Treat namespace dots as editor word separators so typing `T.` or `T.Cell.`
  triggers a fresh completion request in Cursor/VS Code instead of filtering
  the previous word completion list. Keep qualified-name parsing in the LSP.
- Add a regression for the editor word pattern, alongside protocol tests.

## 0.3.0

- Move compiler diagnostics into the LSP; remove duplicate VS Code providers.
- Check complete local import snapshots, including unsaved dependencies and proofs,
  without writing temporary files into the project or executing main.
- Cancel stale checks, serialize compiler work and bound input/output resources.
- Load Base once per compiler; support axiom signatures, constructor placeholders,
  template arguments and explicit completion edit ranges.
- Correct case scopes, multiline parameters and nested signature arguments.
- Add references, conservative project rename, workspace symbols, highlights,
  folding and structural selection.
- Add native read-only Base/guide tabs and per-document configuration.
- Default to diagnostics after typing; add transport, lifecycle and bend-tensor
  integration regressions. Document unsupported semantic features explicitly.

## 0.2.3

- Chain import-alias completion directly into module-member completion, so selecting `MatMul` immediately shows `dot`, `matmul`, `parallel`, and related definitions.

## 0.2.2

- Recognize qualified constructors such as `Cell.new` in imported datatypes.
- Add a native Cursor completion compatibility provider for relative imports.
- Enable trigger-character and quick suggestions by default for Bend documents.

## 0.2.1

- Complete nested qualified names such as `Module.Type.function`.
- Insert function argument placeholders and automatically open parameter hints.
- Load Base signatures from the configured Bend compiler for completion, hover, and signature help.
- Suggest applicable namespace functions after `value.` for explicitly typed bindings and rewrite them to valid Bend calls.

## 0.2.0

- Add a dedicated Language Server Protocol process over IPC.
- Add contextual completion for parameters, local and pattern bindings, declarations, constructors, import aliases, relative modules, Base members, keywords, and snippets.
- Add signature help, local-binding hover and definition, and clickable relative imports.
- Add focused tests for scope extraction and call/completion context.

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
