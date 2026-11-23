# Notesoup Paseo plugin

Client-only renderers: last-word sticky cards and paper cards for notes_read/notes_write/notes_update tool calls. See [OVERVIEW.md](OVERVIEW.md) for behavior and the upstream live-event limitation.

```sh
cd plugins/paseo
npm install --ignore-scripts --package-lock=false
npm run typecheck
npm test
```

Install this directory with `paseo plugin install /absolute/path/to/plugins/paseo`. Source changes require `paseo plugin reload notesoup`; no daemon restart is needed.

## Markdown maintenance

`client/markdown-core.tsx` and `test/markdown-core.test.ts` are manually mirrored,
byte-for-byte, between the Square and pi-context (notesoup) repositories at
`plugins/paseo/`. No shared package or cross-repository runtime import is needed.
When changing rendering behavior, copy both files to the other plugin and run
`npm test && npm run typecheck` in both plugin directories. Compare the files
with `diff -u` before delivery. Each `client/markdown.tsx` owns its palette and
wrapper; do not copy those adapters.

The core handles inline nesting, block structure, selectable text, safe `http(s)`/`mailto`
link presses, and horizontal code/table scrolling. Images render as alt text or `[image]`;
this is not the full Paseo assistant renderer. Tests inspect React elements with RN host
primitives, not native layout. Verify wrapping, selection and scrolling on iOS
before claiming visual or gesture correctness.
