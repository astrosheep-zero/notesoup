# Notesoup Paseo plugin

Client-only last-word renderer. See [OVERVIEW.md](OVERVIEW.md) for behavior and the upstream live-event limitation.

```sh
cd plugins/paseo
npm install --ignore-scripts --package-lock=false
npm run typecheck
npm test
```

Install this directory with `paseo plugin install /absolute/path/to/plugins/paseo`. Source changes require `paseo plugin reload notesoup-last-word`; no daemon restart is needed.
