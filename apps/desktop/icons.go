package main

import (
	"embed"

	"github.com/egoist/mygo/ui"
)

//go:embed assets/tabler/*.svg assets/tabler/LICENSE
var tablerAssets embed.FS

func mustTablerIcon(name string) *ui.SVG {
	data, err := tablerAssets.ReadFile("assets/tabler/" + name + ".svg")
	if err != nil {
		panic(err)
	}
	return ui.MustParseSVG(data)
}

var icons = map[string]*ui.SVG{
	"chevron":     mustTablerIcon("chevron-down"),
	"radio":       mustTablerIcon("broadcast"),
	"Overview":    mustTablerIcon("activity"),
	"Agents":      mustTablerIcon("layout-grid"),
	"Appearance":  mustTablerIcon("palette"),
	"Summaries":   mustTablerIcon("sparkles"),
	"Preferences": mustTablerIcon("adjustments-horizontal"),
	"pin":         mustTablerIcon("pin"),
	"game":        mustTablerIcon("device-gamepad"),
}
