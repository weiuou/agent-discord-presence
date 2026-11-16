# Tabler Icons

The desktop app embeds a small selection of the official [Tabler Icons](https://github.com/tabler/tabler-icons/tree/v3.52.0/icons/outline) outline SVGs from **v3.52.0**, distributed under the included [MIT license](LICENSE).

The SVG files are copied unchanged from `icons/outline/` in that release. To update them, copy the same files and license from a tagged Tabler release and update the version here. No icon package or network access is needed to build or run the app.

| UI element | Tabler icon |
| --- | --- |
| Dropdown chevron | `chevron-down` |
| Presence brand and activity indicator | `broadcast` |
| Overview | `activity` |
| Agents | `layout-grid` |
| Appearance | `palette` |
| Summaries | `sparkles` |
| Preferences | `adjustments-horizontal` |
| Pinned session | `pin` |
| Generic agent fallback | `device-gamepad` |

`icons.go` parses the embedded assets once. Existing `ui.Icon` call sites set their display size and inherit the surrounding text color for both themes. Agent brand artwork remains in `../agents/`.
