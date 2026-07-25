# pi-browse-replies

A [Pi coding agent](https://pi.dev/) extension for browsing, editing, and copying previous assistant replies without terminal wrapping, panel margins, or other screen-rendering artifacts.

## Features

- **Shift+Up** loads the previous complete assistant reply into Pi's editor.
- **Shift+Down** loads the next reply; moving past the newest reply restores your original unsent draft.
- Tool-using runs are grouped by user turn, so commentary before and after tool calls appears as one reply rather than several fragments.
- **Escape** exits reply browsing and restores your draft.
- Replies remain editable before copying.
- The editor's horizontal borders use the active theme's `borderAccent` color while reply browsing is active.
- Plain **Enter/Return** is blocked in reply mode so a browsed reply cannot be submitted accidentally; modified Enter combinations remain available for editing.
- Bare **Up/Down** continues moving through a multi-line reply without accidentally switching to prompt history.
- A configurable shortcut copies the raw editor text using Pi's clipboard integration, including its OSC 52 fallback for remote terminals.
- Local edits are preserved while moving between replies during one browsing session. They do not modify the saved Pi conversation.

While browsing, a compact widget shows the current position and copy key:

```text
Reply 3/12 (shift+up/down to browse, ctrl+shift+c to copy)
```

## Install

Install directly from GitHub:

```bash
pi install git:github.com/dreveman/pi-browse-replies
```

To try a local checkout without installing it:

```bash
pi --no-extensions -e /path/to/pi-browse-replies
```

After installing or changing configuration in a running Pi session, run `/reload` or restart Pi.

## Configuration

The default copy shortcut is `ctrl+shift+c`. Override it in:

```text
~/.pi/agent/pi-browse-replies.json
```

For example:

```json
{
  "copyKey": "alt+c",
  "highlightBorder": true
}
```

- `copyKey` uses the keybinding subset supported by Pi's current runtime, such as `ctrl+shift+c`, `alt+c`, or `f12`. Key names are normalized to lowercase. The literal `+` key is not supported because Pi also uses `+` as its modifier separator.
- `highlightBorder` defaults to `true`. Set it to `false` to avoid installing a custom editor component; reply browsing and copying continue to work without border highlighting.

Missing configuration uses the defaults. Invalid JSON, unknown fields, malformed keys, reserved reply-navigation keys, and invalid option types produce a warning and fall back to the defaults.

The extension reserves `shift+up`, `shift+down`, and `escape`; they cannot be configured as the copy key. Other collisions are diagnosed by Pi's normal extension-shortcut handling. Configuration is intentionally a persistent per-user file rather than a CLI flag. Changes take effect after `/reload` or a restart.

### iTerm2 and Command+C

macOS terminals normally consume Command+C before a terminal application can receive it. To map a macOS shortcut while preserving ordinary selection copy:

1. Open **iTerm2 Settings → Profiles → Keys → Key Mappings**.
2. Map Command+Shift+C to **Send Escape Sequence** with value `c`.
3. Configure:

   ```json
   {
     "copyKey": "alt+c"
   }
   ```

Alternatively, map a shortcut to F12 and set `"copyKey": "f12"`.

Pi's clipboard helper uses native clipboard commands when available and falls back to OSC 52. For Pi running on a remote devserver, ensure iTerm2 allows terminal applications to access the clipboard.

## Behavior notes

- Only normal Pi assistant messages are included; the extension does not depend on or special-case other extensions.
- A "reply" is all assistant text associated with one user turn. Tool results, tool calls, and thinking blocks are not copied.
- Browsing places reply text in the editor, but plain Enter/Return is consumed until you leave reply mode with Escape or Shift+Down past the newest reply. This prevents accidental resubmission.
- The copy shortcut copies current editor text. In reply mode that is the selected, possibly edited reply; outside reply mode it copies the current draft. Copying never changes the persisted session.
- Border coloring composes with a custom editor installed by an earlier extension when that editor exposes Pi's standard `borderColor` property. A later extension can still replace the editor component.
- Pi's custom-editor API does not expose the configured autocomplete maximum. Installing the editor used for border highlighting can temporarily restore the default autocomplete row count until the next session start, resume, or settings change. Set `highlightBorder` to `false` to avoid the editor swap entirely.
- Escape is intercepted only while reply browsing is active. Outside reply mode, Pi retains its normal Escape behavior.
- The extension reads replies from the active session branch, so it works after resume and follows Pi's current conversation branch.
- Pi does not expose an API for temporarily disabling its private prompt-history navigation. The extension therefore repairs the editor text if bare Up/Down crosses into prompt history while browsing. At that boundary, restoring text may move the cursor to the end of the reply.

## Development

Install development dependencies, then run type checking, automated tests, and the Pi load smoke test:

```bash
npm install
npm run verify
```

The individual commands are:

```bash
npm run check
npm test
npm run smoke
```

On hosts where npm tooling is restricted, the runtime tests can still be run directly:

```bash
pi --no-extensions --offline -e ./test/run.ts --list-models
pi --no-extensions --offline -e . --list-models
```

Before publishing, verify that every script dependency is included in the tarball:

```bash
npm pack --dry-run
```

For an interactive test, produce two assistant replies, type an unsent draft, and verify:

1. Shift+Up/Down navigates replies.
2. Bare Up/Down moves through multi-line reply text.
3. Editing followed by the configured copy shortcut copies the edited, unwrapped text.
4. The editor borders use the theme's `borderAccent` color in reply mode and return to normal afterward.
5. Plain Enter does not submit a browsed reply; modified Enter remains usable for editing.
6. Escape restores the original draft.
7. Shift+Down past the newest reply also restores the draft.

## License

MIT — see [LICENSE](LICENSE).
