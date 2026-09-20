# Bend 2 Language Support

A small, unofficial Bend 2 language server and VS Code/Cursor extension, validated
with **Bend 2.0.5** and the `bend-tensor` project. Requires a trusted workspace and
Bend on `PATH` (or an absolute `bend2.executablePath`).

## Start here

1. Install the VSIX and open your Bend project folder.
2. Open a `.bend` file. Diagnostics update after a 600 ms typing pause.
3. Type `T.` after `import ./Tensor.bend as T`, or `F32.` after `import Base`.
   Completion inserts arguments and opens signature help. Hover reads source docs.
4. Use **F12** for definitions, **Shift+F12** for references, **Ctrl+T** for project
   symbols, and **F2** for supported renames.
5. Use **Bend 2: Show Language Guide** or **Show Base Documentation** for read-only,
   searchable editor tabs containing documentation from your installed compiler.

The compiler installation instructions and language reference are available at
[the official Bend site](https://www.bend-lang.com/). This extension is not
associated with the language maintainers.

## What works

| Feature | Scope |
| --- | --- |
| Diagnostics | Compiler checks, local import graph, unsaved buffers, proof companion, debounce/cancellation |
| Completion | Parameters, scoped local/pattern bindings, declarations, constructors, module aliases, Base, snippets |
| Signature help | Functions, Base axioms such as `F32.add`, law binders, nested argument lists |
| Documentation | Source comments on hover; compiler Base and guide in editor tabs |
| Definition and links | Local declarations/bindings and direct relative imports |
| References/highlights | Resolved names in local project sources; comments and strings excluded |
| Rename | Simple top-level project declarations and qualified uses; versioned workspace edits |
| Symbols | Document outline with body ranges; bounded project symbol search |
| Structure | Indentation folding and word/line/declaration selection |
| Syntax | TextMate highlighting, indentation, brackets, language snippets |

Completion edits only the member after the dot, preserving module aliases even
when the editor treats a qualified name as one word. Template arguments retain
`~`. For explicitly typed Base bindings, `value.` offers namespace functions and
rewrites a choice into a valid call such as `U32.add(value, argument)`.

## Commands

- **Bend 2: Check Current File** — check current buffers without executing `main`.
- **Bend 2: Run Current File** — save dirty Bend files, then run `bend <file>` in a
  process task. This executes the program. Pure F32 calls may remain symbolic on
  this backend; compile with `bend <file> -o <binary>` for native numeric execution.
- **Bend 2: Show Base Documentation** — inspect a Base name or the whole library.
- **Bend 2: Show Language Guide** — open the installed compiler's guide.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `bend2.executablePath` | `bend` | Executable, without arguments; `~/` is expanded |
| `bend2.lint.run` | `onType` | `onType`, `onSave`, or `off`; manual check always works |
| `bend2.lint.onOpen` | `true` | Automatically check opened documents |
| `bend2.lint.lawsThroughProof` | `true` | Check `LAWS.bend` through a sibling importing `PROOF.bend` |
| `bend2.lint.delay` | `600` | Typing debounce, 100–10000 ms |
| `bend2.lint.timeout` | `20000` | Check timeout, 1000–120000 ms |

Settings are resolved per document, including workspaces with several folders.
No project manifest or separate language-server installation is needed.

## Checking and safety

A check copies the complete relative-import graph into a private OS temporary
directory and rewrites imports to those copies. Each source is copied once, so
shared modules retain their identity. Open buffers replace disk contents. A tiny
import-only entry checks the graph without executing its `main`. For `LAWS.bend`,
the same graph includes the sibling `PROOF.bend` when it imports those laws.
Temporary files are removed after success, errors, cancellation and timeout.

Checks run one at a time, with a 1 MiB output limit and a 512-module/32 MiB graph
limit. Source reads are limited to regular files of 2 MiB. Edits cancel pending
checks and discard obsolete diagnostics. Closing files clears their diagnostics.
Compiler invocation uses argument arrays, no shell interpolation, and
`BEND_NO_TELEMETRY=1`. On Unix, cancellation kills the compiler process group.
Workspace Trust prevents extension activation in untrusted folders.

These controls are not an operating-system sandbox: the configured executable
runs with your account's privileges. Bend may resolve/download hash imports.
The Run command deliberately uses the user's normal Bend environment. Windows
child-process-tree cleanup has not been validated; Linux is the tested platform.

Bend 2.0.5 reports text errors without reliable file paths or columns. When an
excerpt cannot be matched to the current source, the diagnostic is attached to
its first line with the compiler excerpt retained. TODOs without locations are
reported as proof obligations. No inferred error location is presented as exact.

## Deliberate boundaries

This server uses a small structural parser; the Bend compiler remains responsible
for dependent types, affine use, termination and proof validity. It does not
implement full semantic inference, a formatter, semantic tokens, inlay hints,
auto-import/code actions, or automatic proof generation. Complex lambda/type
binder scopes and re-export navigation are not a complete compiler AST model.

Rename refuses local binders, `main`, Base, dotted declaration names, names that
already occur in the project, shadowed declarations and declarations outside the
workspace. Project search is bounded to 1024 Bend files/32 MiB and 20000 directory
entries, excluding common generated directories; symbolic links cause it to stop
rather than claim a complete project rename. References/rename cover local files
in the open workspace, not external consumers of a published package. Review the
editor's rename preview and run project proofs after refactoring.

Hash-package navigation and completion are not indexed; their validation is left
to the compiler. For full behavior, use relative imports within the open project.
A missing compiler leaves source-based editor features available but cannot
provide compiler diagnostics or current Base documentation.

## Development and validation

```sh
npm ci
npm test                    # parser, protocol and process/lifecycle regressions
npm run check               # syntax-check every source module
npm run test:integration    # real Bend + ../bend-tensor
npm run package             # produces bend2-language-support-0.3.1.vsix
```

The integration suite requires Bend and the sibling `bend-tensor` checkout.
Override `BEND2_TEST_PROJECT` and `BEND2_TEST_COMPILER` to use other paths. It checks
all eleven valid project modules, the intentionally invalid MatMul, Base docs,
constructor completion, navigation, unsaved imports and non-execution of IO main.
Run `python3 tests/test.py` inside `bend-tensor` for its native numerical tests.

Open this extension folder and press **F5** for an Extension Development Host.
Install the package using your editor's **Extensions: Install from VSIX** command
(or `cursor --install-extension bend2-language-support-0.3.1.vsix`).

The core has one implementation of language features in `server.js`, with small
modules for structural parsing, navigation, diagnostics, snapshots and process
lifecycle. `extension.js` contains only the editor adapter and commands. Standard
LSP clients can also launch `node src/server.js --stdio`; the custom requests are
`bend2/check` (`{uri}`) and `bend2/documentation` (`{uri, query}`).
