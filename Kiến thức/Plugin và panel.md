# Plugins and panels installed for Premiere — which ones the MCP can drive, which are manual

Updated 2026-10-23. Task → tool → plugin map: `Chọn tool và plugin`.

- **Mako** (`com.basicsstudio.mako`): driven directly through the `mako` tool (same `session` script engine; the Mako panel must have loaded once in the current Premiere session): adjustment_layer (over a range, per clip, per cut), staircase/unstaircase, freeze_frame, fit_frame (fit/fill), nest/unnest with effects kept, clear_effects, quality_check (gaps red, offline orange, disabled clips yellow, 1–2 frame leftovers purple), delete_empty_tracks, new_sequence, transparency_grid. The adjustment layers used by `add_color_layer` and `create_aspect_versions` also come from Mako's template.
- **Film Impact Dashboard**: the transitions are built into Premiere and applied by name (see `Chuyển cảnh Film Impact.md`).
- **Premiere Composer / Animation Composer** (Mister Horse): a cloud preset library, encrypted inside the plugin and applied only through its panel; the MCP cannot drive it reliably. When a brief needs a Composer-style move, apply it by hand or use the After Effects MCP equivalent (`anim.*`, `template.*`, `anim.scene_transition`). Installed: panel `com.misterhorse.PremiereComposer` and its MediaCore helpers (`MHPC_AeRenderHelper`, `MHPC_Importer`, `MHPC_InitHelper`, `MHPC_ControlSurface`).
- **Beauty Box** (Digital Anarchy 5.0.4, in MediaCore so both Premiere and After Effects see it): skin smoothing for interviews and portraits. Apply with `apply_effect` using the display name from `list_available_effects`, adjust with `set_effect_property`; heavy, apply after picture lock.
- **Motion Bro, Motion Array, Epidemic Sound, BeatEdit, AutoCut**: manual panels; BeatEdit/AutoCut can be replaced by the media engine (beats, silence cuts).
- Colour plate for a logo: `add_color_matte` (white/black/hex), not Premiere's Color Matte, whose colour picker blocks scripting.

- **Proxies**: the first step of every job with 4K footage — `create_proxies` (`Proxies/` next to the source, attached automatically; turn on Toggle Proxies in the Program Monitor while editing, off when exporting).
