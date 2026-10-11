# Animations from files

Put an `.html` file here and notGT registers it as a code animation with the id
`file-<file-name>`: on start, or right away with `POST /api/animations/sync`. Delete the
file and the animation leaves the library, with its placements.

The file is an ordinary page. The runtime (`vars`, `onData`, `onShow`, `onHide`,
`[data-bind]`) and the brand fonts are added to it automatically — see
[“Animations from files”](../../README.md#animations-from-files-without-the-web-editor)
in the bundle's README.
