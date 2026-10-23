# Film Impact transitions — names in Premiere 2026, when to use them, durations

Updated 2026-10-23. Film Impact ships inside Premiere 26.5's Video Transitions list (no "Impact" prefix any more). Apply by name with `add_transition`, `add_transition_to_clip` or `batch_add_transitions { sequenceId, trackIndex, transitionName, duration }` (tested for real: "Light Leak" on every cut). The "Film Impact Dashboard" panel is only for browsing and tweaking; fine-tune parameters in Effect Controls after applying.

| Family | Transition names | Use for | Suggested duration |
|---|---|---|---|
| Light | Light Leak, Chroma Leak, Light Sweep, Flare, Flash, Glow, Ray | Hotels, resorts, premium F&B, soft emotional changes; Flash for event recaps on the beat | Leaks 16–24 frames; Flash 4–8 frames |
| Motion | Push, Slide, Whip, Pull Motion, Pop Motion, Spin Motion, Spring Motion, Travel Motion, Block Motion, Flip Motion, Fold Motion, Motion Tween | Fast reels, F&B, retail sales; Whip following the camera pan | 8–12 frames, exactly on the beat |
| 3D | 3D Roll, 3D Spinback, Page Peel, Roll, Film Roll | Topic changes, introducing a dish, event chapters | 12–16 frames |
| Blur, zoom | Zoom Blur, Directional Blur, Radial Blur, Lens Blur, Blur Dissolve, Cross Zoom | Building energy, cutting along the direction of motion; Blur Dissolve for slow resort pieces | 8–14 frames |
| Distortion, noise | Glitch, VHS Damage, Earthquake, Chaos, Liquid Distortion, Wave, Phosphor, TV Power | Youth teasers, music events, hard beat hits | 4–10 frames |
| Shapes | Linear Wipe, Radial Wipe, Clock Wipe, Star Wipe, Neon Wipe, Panel Wipe, Plateau Wipe, Shape Flow, Shape Dissolve, Stripe, Slice, Mosaic, Kaleidoscope, Mirror, Split, Stretch, Stretch Wipe | Graphic design, menus, promotions | 10–16 frames |
| Classic soft | Cross Dissolve, Additive Dissolve, Film Dissolve, Luma Fade, Dip to Black, Dip to White, Dip to Color, Non-Additive Dissolve | Slow resort pieces, interviews, endings | 12–24 frames |
| Text | Typewriter, Text Animator | Transitions that carry text | Depends on text length |

Rules: one video uses one or two main transition families; never put a transition on a cut with a strong music hit unless it lands on the beat; change families between jobs instead of repeating one style everywhere.

Choosing by situation (one table shared by Premiere and After Effects): `After Effects/Kiến thức/Công thức/Chọn chuyển cảnh.md` (read with ae_guide).
