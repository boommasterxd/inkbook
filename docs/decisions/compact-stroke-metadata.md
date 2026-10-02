# Compact Stroke Metadata

## Status

Accepted. Extends the version 1 disk representation without changing the logical snapshot or clipboard schema.

## Context

Numeric-array JSON repeats decimal spelling for every stroke sample and allocates a parsed array before conversion to runtime buffers. The format already requires canonical coordinate thousandths and pressure ten-thousandths, so those exact values admit a smaller integer representation.

## Decision

Current writers use `json-varint-v1` metadata with canonical Base64 strings for stroke samples. The [file-format contract](../file-format.md#disk-metadata-encoding) defines point counts, ZigZag coordinate deltas, unsigned pressure, LEB128 and Base64 canonicality, allocation checks, and resource limits. Shape fields, format version, sample precision, and logical clipboard triples remain unchanged. Decode allocates one exact-size `Float64Array` and then applies complete semantic validation.

Every canonical writer and independent metadata integrity manifest hashes the same compact disk JSON. Readers hash supplied decoded metadata text before interpreting it. Legacy `json` remains readable and unlocking it alone creates no migration or rewrite obligation; the next ordinary save emits the current encoding. Snapshot-version migration and stylesheet compatibility retain their existing rewrite rules.

## Consequences and Verification

Saved SVG remains standalone and its static presentation is unchanged. Older builds without the new metadata decoder cannot edit compact files, so all devices must be updated before saving. This is encoding, not compression or lossy point reduction.

Regression coverage must verify exact canonical-value round trips, both reader encodings, canonical hash agreement across writers, malformed Base64 and varints, count and allocation limits, coordinate and pressure bounds, cancellation, and unchanged clipboard semantics. Deterministic byte and allocation bounds do not establish physical-device load or save latency.
