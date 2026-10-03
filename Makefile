# The plugin builds slapd itself on first run; these are for development.
SLAPD = plugin/bin/slapd

$(SLAPD): plugin/slapd/main.swift
	mkdir -p plugin/bin
	swiftc -O -swift-version 5 -o $@ $<

slapd: $(SLAPD)

raw: $(SLAPD)
	$(SLAPD) --raw --no-lock

# Terminal cells for the faces drawn above the prompt.
faces: plugin/hooks/faces.ts

plugin/hooks/faces.ts: tools/faces.swift $(wildcard assets/faces/level_*.png)
	swift tools/faces.swift

.PHONY: slapd raw faces
