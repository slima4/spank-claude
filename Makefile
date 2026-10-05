# The plugin builds slapd itself on first run; these are for development.
SLAPD = plugin/bin/slapd

$(SLAPD): plugin/slapd/main.swift
	mkdir -p plugin/bin
	swiftc -O -swift-version 5 -o $@ $<

slapd: $(SLAPD)

raw: $(SLAPD)
	$(SLAPD) --raw

# Terminal cells for each face series drawn above the prompt, and any of its
# pictures missing. Always runs: the pictures are not tracked here.
faces:
	swift tools/faces.swift

.PHONY: slapd raw faces
