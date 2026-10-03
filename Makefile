MOD ?= plugin

slapd/slapd: slapd/main.swift
	swiftc -O -swift-version 5 -o $@ $<

install: slapd/slapd
	mkdir -p $(MOD)/bin
	cp slapd/slapd $(MOD)/bin/slapd

raw: slapd/slapd
	./slapd/slapd --raw

# Terminal cells for the faces drawn above the prompt.
faces: plugin/hooks/faces.ts

plugin/hooks/faces.ts: tools/faces.swift $(wildcard assets/faces/level_*.png)
	swift tools/faces.swift

.PHONY: install raw faces
