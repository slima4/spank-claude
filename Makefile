MOD ?= plugin

slapd/slapd: slapd/main.swift
	swiftc -O -swift-version 5 -o $@ $<

install: slapd/slapd
	mkdir -p $(MOD)/bin
	cp slapd/slapd $(MOD)/bin/slapd

raw: slapd/slapd
	./slapd/slapd --raw

.PHONY: install raw
