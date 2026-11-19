#!/usr/bin/env python3
"""Unpack a Chrome CRX3 file into a directory Chromium can load unpacked.

The developer public key embedded in the CRX header is written into
manifest.json as "key", so the unpacked extension keeps its Chrome Web
Store ID (LINE's servers check the chrome-extension:// origin). The
"update_url" entry is removed so Chromium never tries to auto-update the
pinned copy.

With --overlay, the files in that directory are copied into the extension,
and --service-worker replaces the manifest's background service worker
(Twine uses this to wrap LINE's background.js with its bootstrap worker).

Usage: crx_unpack.py [--overlay DIR] [--service-worker FILE]
                     <file.crx> <output-dir> [expected-extension-id]
"""
import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import sys
import zipfile


def read_varint(buf, pos):
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def parse_fields(buf):
    """Minimal protobuf decoder: yields (field_number, wire_type, value)."""
    pos = 0
    while pos < len(buf):
        tag, pos = read_varint(buf, pos)
        field, wtype = tag >> 3, tag & 7
        if wtype == 0:
            value, pos = read_varint(buf, pos)
        elif wtype == 2:
            length, pos = read_varint(buf, pos)
            value = buf[pos:pos + length]
            pos += length
        elif wtype == 1:
            value, pos = buf[pos:pos + 8], pos + 8
        elif wtype == 5:
            value, pos = buf[pos:pos + 4], pos + 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wtype}")
        yield field, wtype, value


def extension_id(public_key):
    digest = hashlib.sha256(public_key).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def main():
    parser = argparse.ArgumentParser(description="Unpack a CRX3 extension.")
    parser.add_argument("crx")
    parser.add_argument("out_dir")
    parser.add_argument("expected_id", nargs="?")
    parser.add_argument("--overlay", help="directory of extra files to copy in")
    parser.add_argument("--service-worker", help="replacement background service worker")
    args = parser.parse_args()
    crx_path, out_dir, expected = args.crx, args.out_dir, args.expected_id

    data = open(crx_path, "rb").read()
    if data[:4] != b"Cr24":
        sys.exit("not a CRX file")
    version = int.from_bytes(data[4:8], "little")
    if version != 3:
        sys.exit(f"unsupported CRX version {version}")
    header_len = int.from_bytes(data[8:12], "little")
    header = data[12:12 + header_len]
    archive = data[12 + header_len:]

    # CrxFileHeader: 2 = sha256_with_rsa, 3 = sha256_with_ecdsa,
    # 10000 = signed_header_data (SignedData { 1: crx_id }).
    keys, crx_id = [], None
    for field, _, value in parse_fields(header):
        if field in (2, 3):
            for f, _, v in parse_fields(value):
                if f == 1:
                    keys.append(v)
        elif field == 10000:
            for f, _, v in parse_fields(value):
                if f == 1:
                    crx_id = v
    if crx_id is None:
        sys.exit("CRX header has no crx_id")

    key = next((k for k in keys if hashlib.sha256(k).digest()[:16] == crx_id), None)
    if key is None:
        sys.exit("no public key in the CRX header matches its crx_id")
    ext_id = extension_id(key)
    if expected and ext_id != expected:
        sys.exit(f"extension ID mismatch: got {ext_id}, expected {expected}")

    os.makedirs(out_dir, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        for name in zf.namelist():
            target = os.path.realpath(os.path.join(out_dir, name))
            if not target.startswith(os.path.realpath(out_dir) + os.sep):
                sys.exit(f"refusing to extract outside output dir: {name}")
        zf.extractall(out_dir)

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, encoding="utf-8-sig") as f:
        manifest = json.load(f)
    manifest.pop("update_url", None)
    manifest["key"] = base64.b64encode(key).decode()

    if args.overlay:
        shutil.copytree(args.overlay, out_dir, dirs_exist_ok=True)
    if args.service_worker:
        if not os.path.isfile(os.path.join(out_dir, args.service_worker)):
            sys.exit(f"service worker {args.service_worker} not found in extension")
        manifest["background"] = {"service_worker": args.service_worker, "type": "module"}
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"unpacked {manifest.get('name')} {manifest.get('version')} ({ext_id}) to {out_dir}")


if __name__ == "__main__":
    main()
