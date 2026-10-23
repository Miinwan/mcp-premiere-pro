# Colour grading — one colour layer per source, the same source shares its values

Project rule (2026-10-23):
- Colour goes on a separate adjustment layer for each scene (each source), never on one layer for the whole video.
- When the same source appears in several places on the timeline, its layers share the name "Màu <source>" and identical values, so the grade never drifts between appearances.
- Two different sources always get two separate colour layers.

With the MCP:
1. `add_scene_color_layers { sequenceName, sourceTrack, basic, perSource }` creates "Màu <source>" layers on a new track; neighbouring clips from the same source share one layer, with Lumetri Color ready.
2. Grade one layer (by hand, or with `set_lumetri_basic` / `match_color`), then `sync_color_layers` so every layer with that name gets the full set of Lumetri parameters (basic, creative, curves, wheels, HSL, vignette). `fromPlayhead: true` uses the layer under the playhead as the master.
3. Use `add_color_layer` only for a global look over the whole video (if needed), above the scene layers.
4. Square/vertical versions (`create_aspect_versions`) keep the colour layers and scale them to cover the new frame.
