# Bend 2 Language Support for VS Code

[![Open VSX](https://img.shields.io/open-vsx/v/CaioWing-bender/bend2-language-support)](https://open-vsx.org/extension/CaioWing-bender/bend2-language-support)

Unofficial VS Code support for the current Bend 2 syntax and compiler. This extension is not affiliated with the Bend language maintainers and was developed against **Bend 2.0.5**.

## Features

- TextMate syntax highlighting for `.bend` files.
- Compiler-backed diagnostics in the Problems panel.
- Safe checks that import a temporary copy of the file, so linting never executes its `main` function.
- Configurable checks on open, save, or after typing.
- Bend 2 keywords, local declarations, and imported-module member completions.
- Hover help for core language concepts and declarations.
- Go to Definition for local declarations and members of relative imports.
- Outline symbols for definitions, types, constructors, and laws.
- Snippets for definitions, datatypes, matches, IO, laws, proofs, arrays, and parallel calls.
- Commands to check a file, run a file, and query `bend base` documentation.

## Requirements

Install Bend 2 and make `bend` available on `PATH`:

```sh
curl -fsSL https://bend-lang.com/install.sh | sh
bend --version
```

Alternatively, set `bend2.executablePath` to the executable's absolute path.

## Commands

Open the Command Palette and run:

- **Bend 2: Check Current File** — type-checks the editor contents without running `main`.
- **Bend 2: Run Current File** — saves and runs the file in a VS Code task.
- **Bend 2: Show Base Documentation** — runs `bend base <name>` for the selection or symbol under the cursor.

The status-bar check icon also runs the current-file check.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `bend2.executablePath` | `bend` | Compiler executable name or absolute path |
| `bend2.lint.run` | `onSave` | `onSave`, `onType`, or `off` |
| `bend2.lint.onOpen` | `true` | Check a file when it opens |
| `bend2.lint.lawsThroughProof` | `true` | Check `LAWS.bend` through its sibling `PROOF.bend` |
| `bend2.lint.delay` | `600` | Debounce delay for `onType`, in milliseconds |
| `bend2.lint.timeout` | `20000` | Maximum check duration, in milliseconds |

Example:

```json
{
  "bend2.executablePath": "~/.bend/bin/bend",
  "bend2.lint.run": "onType",
  "bend2.lint.delay": 800
}
```

## How linting works

The current editor text is copied to a uniquely named, short-lived `.bend` file beside the original. A second temporary module imports that copy. Running Bend on the import-only module checks the program and its imports but does **not** execute `main`. Both files are removed when the compiler exits.

By Bend convention, `LAWS.bend` contains open claims and `PROOF.bend` imports and closes them. Checking `LAWS.bend` alone would therefore report TODOs even when the project proof gate passes. With `bend2.lint.lawsThroughProof` enabled, the extension detects a sibling `PROOF.bend`, redirects its `LAWS.bend` import to the temporary editor contents, and checks that complete graph instead. It also honors unsaved `PROOF.bend` contents when that document is open.

Compiler line diagnostics are mapped back to the current editor. Bend 2.0.5 does not emit file paths or columns in its text diagnostics. If Bend reports only `N TODOs found`, the extension explains that these are unresolved proof obligations and whether `PROOF.bend` participated; when all laws were checked without a companion, each declaration receives a specific diagnostic. If an imported module fails and its source excerpt does not match the current file, the extension places the error at the top of the current file and preserves the compiler excerpt in the message.

Automated checks set `BEND_NO_TELEMETRY=1` for frequent, deterministic compiler invocations. The explicit **Run Current File** task uses the user's normal Bend environment.

## Development

Open `vscode-bend2` as the VS Code workspace, then press **F5** to launch an Extension Development Host.

```sh
npm test
npm run check
npm run package
```

`npm run package` uses the pinned `@vscode/vsce` development dependency and creates a `.vsix` that can be installed with:

```sh
code --install-extension bend2-language-support-0.1.2.vsix
```

Tagged releases named `vscode-bend2-v<version>` are validated, published to Open VSX, and attached to a matching GitHub Release by `.github/workflows/release-vscode-extension.yml`. The tag version must equal the version in `package.json`.

## Current scope

This is a lightweight compiler integration, not a full language server. Bend's compiler remains the source of truth for types, affine-use checks, termination, and proofs. Completion parsing intentionally covers top-level declarations and direct relative imports rather than attempting semantic type inference.
