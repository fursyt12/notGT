/**
 * notGT's Spout library (Windows): an out shared as a Spout 2 sender, for
 * Resolume, TouchDesigner and OBS on the same computer. The notGT sender
 * (../ndi) renders the out pages and hands their frames to it.
 *
 *   loadSpout()  the addon (native/, Rust), or why there is none
 *   SpoutSink    one out's frames into one Spout sender
 */
export { addonName, loadSpout } from "./src/native.mjs";
export { SpoutSink } from "./src/sink.mjs";
