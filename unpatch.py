#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = [
#     "capstone>=5.0.6",
#     "lief>=0.17.3",
# ]
# ///
"""Restore a MuTube-patched IPA back to the original decrypted YouTube IPA.

patcher.py only ever modifies the YouTubeUnstable binary, in three ways:
  1. writes strings and hook stubs into the __TEXT header padding (between
     the Mach-O load commands and __text), and the JS payload into the unused
     tail of __TEXT (older versions put the payload in the header padding);
  2. replaces one instruction per hook with `bl <stub>`; the displaced
     original instruction is kept inside the stub, right before its final
     `ret`;
  3. overwrites the COBALT_HDR_PATCHES instructions with fixed replacements.

This script undoes each of those: it follows every `bl` to its stub, copies
the saved original instruction back, re-encodes the HDR gate instructions
from their `expect` values, and zeroes the padding the patcher used. Each
restored instruction is disassembled and checked against patcher.py's
`expect`, so the result is accepted by patcher.py again.

Only IPAs produced by the Frida-less patcher (commit 8a8b260 and later) for
YouTube 4.54.01 are supported.
"""
import argparse
import struct
import sys
import zipfile
from pathlib import Path

from patcher import (
    COBALT_HDR_PATCHES,
    COBALT_HOOKS,
    PATCHES,
    SAVE_SIZE,
    disasm_one,
    parse_macho_info,
    read_u32,
    resolve_patch_site,
    va_to_off,
)

RET = 0xD65F03C0
# Upper bound on how far past a stub's start we look for its tail. Stubs are
# a few hundred bytes; the media_support stub is the largest.
MAX_STUB_SCAN = 0x4000


class RestoreError(Exception):
    pass


def insn_is(word, va, expect):
    # True when `word` disassembles at `va` to exactly (mnemonic, op_str).
    try:
        ins = disasm_one(struct.pack("<I", word), va)
    except ValueError:
        return False
    return (ins.mnemonic, ins.op_str) == expect


def decode_bl(word, pc):
    # Return the target of a direct BL, or None if `word` is not a BL.
    if word & 0xFC000000 != 0x94000000:
        return None
    imm26 = word & 0x03FFFFFF
    if imm26 & (1 << 25):
        imm26 -= 1 << 26
    return pc + imm26 * 4


def encode_branch(mnemonic, op_str, va):
    # Encode the B / CBZ / CBNZ instructions used by COBALT_HDR_PATCHES.
    if mnemonic == "b":
        target = int(op_str.lstrip("#"), 16)
        imm = (target - va) >> 2
        if not (-(1 << 25) <= imm < (1 << 25)):
            raise RestoreError(f"b target out of range at {hex(va)}")
        return 0x14000000 | (imm & 0x03FFFFFF)
    if mnemonic in ("cbz", "cbnz"):
        reg, tgt = (s.strip() for s in op_str.split(","))
        target = int(tgt.lstrip("#"), 16)
        imm = (target - va) >> 2
        if not (-(1 << 18) <= imm < (1 << 18)):
            raise RestoreError(f"{mnemonic} target out of range at {hex(va)}")
        sf = 1 if reg[0] == "x" else 0
        op = 0x35000000 if mnemonic == "cbnz" else 0x34000000
        return (sf << 31) | op | ((imm & 0x7FFFF) << 5) | int(reg[1:])
    raise RestoreError(f"don't know how to encode {mnemonic} {op_str}")


def padding_off(info, va):
    # Map a __TEXT VA to a file offset that must lie in the header padding.
    off = info["text_seg_off"] + (va - info["text_seg_va"])
    if not (info["header_end"] <= off < info["text_off"]):
        return None
    return off


def find_stub_tail(data, info, stub_off, site_va, expect):
    # Every stub ends with:  add sp, sp, #SAVE_SIZE ; <original insn> ; ret
    # Scan forward from the stub start for that exact sequence, where the
    # original instruction must disassemble (at the hook site) to `expect`.
    add_sp = ("add", f"sp, sp, #0x{SAVE_SIZE:x}")
    limit = min(stub_off + MAX_STUB_SCAN, info["text_off"] - 4)
    for off in range(stub_off + 4, limit, 4):
        word = read_u32(data, off)
        if (
            read_u32(data, off + 4) == RET
            and insn_is(word, site_va, expect)
            and insn_is(read_u32(data, off - 4), 0, add_sp)
        ):
            return word, off + 8
    return None


def restore_hooks(data, info, report):
    # Returns the file offset just past the last stub found (0 if none).
    used_end = 0
    for p in PATCHES + COBALT_HOOKS:
        site_va, site_off, word, ins = resolve_patch_site(data, info, p["entry_va"])
        if (ins.mnemonic, ins.op_str) == p["expect"]:
            report.append(f"{p['name']}: already original, skipped")
            continue

        stub_va = decode_bl(word, site_va)
        stub_off = padding_off(info, stub_va) if stub_va is not None else None
        if stub_off is None:
            raise RestoreError(
                f"{p['name']}: at {hex(site_va)} found '{ins.mnemonic} {ins.op_str}', "
                "which is neither the original instruction nor a MuTube hook"
            )

        tail = find_stub_tail(data, info, stub_off, site_va, p["expect"])
        if tail is None:
            raise RestoreError(
                f"{p['name']}: could not find the saved original instruction "
                f"in the stub at {hex(stub_va)}"
            )
        orig, end = tail
        data[site_off:site_off + 4] = struct.pack("<I", orig)
        used_end = max(used_end, end)
        report.append(f"{p['name']}: restored {hex(site_va)} (stub at {hex(stub_va)})")
    return used_end


def restore_hdr(data, info, report):
    for p in COBALT_HDR_PATCHES:
        off = va_to_off(info, p["va"])
        word = read_u32(data, off)
        if insn_is(word, p["va"], p["expect"]):
            report.append(f"{p['name']}: already original, skipped")
            continue
        if word != p["replacement"]:
            ins = disasm_one(struct.pack("<I", word), p["va"])
            raise RestoreError(
                f"{p['name']}: at {hex(p['va'])} found '{ins.mnemonic} {ins.op_str}', "
                "which is neither the original instruction nor the MuTube patch"
            )
        orig = encode_branch(*p["expect"], p["va"])
        if not insn_is(orig, p["va"], p["expect"]):
            raise RestoreError(f"{p['name']}: re-encoded instruction does not match expect")
        data[off:off + 4] = struct.pack("<I", orig)
        report.append(f"{p['name']}: restored {hex(p['va'])}")


def verify_original(data, info):
    # Same checks patcher.py runs before patching.
    for p in PATCHES + COBALT_HOOKS:
        site_va, _, _, ins = resolve_patch_site(data, info, p["entry_va"])
        if (ins.mnemonic, ins.op_str) != p["expect"]:
            raise RestoreError(f"verify failed: {p['name']} at {hex(site_va)}")
    for p in COBALT_HDR_PATCHES:
        word = read_u32(data, va_to_off(info, p["va"]))
        if not insn_is(word, p["va"], p["expect"]):
            raise RestoreError(f"verify failed: {p['name']} at {hex(p['va'])}")


def restore_binary(data):
    info = parse_macho_info(data)
    report = []
    used_end = restore_hooks(data, info, report)
    restore_hdr(data, info, report)

    # patcher.py allocates sequentially from header_end and places stubs last,
    # so [header_end, end of last stub) is exactly the region it wrote.
    start = info["header_end"]
    if used_end > start:
        data[start:used_end] = bytes(used_end - start)
        report.append(f"cleared header padding {hex(start)}-{hex(used_end)} ({used_end - start} bytes)")
    leftover = any(data[used_end or start:info["text_off"]])
    if leftover:
        report.append("warning: non-zero bytes remain in header padding (left untouched)")

    # Newer patcher versions put the JS payload in the (originally all-zero)
    # unused tail of __TEXT.
    tail_start, tail_end = info["tail_start"], info["tail_end"]
    if any(data[tail_start:tail_end]):
        data[tail_start:tail_end] = bytes(tail_end - tail_start)
        report.append(f"cleared __TEXT tail {hex(tail_start)}-{hex(tail_end)}")

    verify_original(data, info)
    return report


def restore_ipa(in_path, out_path):
    with zipfile.ZipFile(in_path, "r") as zin:
        infos = zin.infolist()
        if any("FridaGadget" in i.filename for i in infos):
            raise RestoreError(
                "this IPA was built by the old Frida-based MuTube "
                "(insert_dylib --strip-codesig + gum-graft) and cannot be restored; "
                "please obtain a fresh decrypted IPA instead"
            )
        bin_info = next((i for i in infos if i.filename.endswith("/YouTubeUnstable")), None)
        if not bin_info:
            raise RestoreError("YouTubeUnstable binary not found in IPA")

        binary = bytearray(zin.read(bin_info.filename))
        report = restore_binary(binary)

        with zipfile.ZipFile(out_path, "w") as zout:
            for info in infos:
                payload = binary if info.filename == bin_info.filename else zin.read(info.filename)
                zout.writestr(info, payload)
    return report


def main():
    ap = argparse.ArgumentParser(description="Restore a MuTube-patched IPA (YouTube 4.54.01)")
    ap.add_argument("--in", dest="inp", required=True, help="MuTube-patched IPA path")
    ap.add_argument("--out", dest="outp", required=True, help="restored IPA path")
    ap.add_argument("--force", action="store_true", help="overwrite --out if it exists")
    args = ap.parse_args()

    inp, outp = Path(args.inp), Path(args.outp)
    if inp.resolve() == outp.resolve():
        sys.exit("error: --in and --out must be different files")
    if outp.exists() and not args.force:
        sys.exit(f"error: {outp} already exists (use --force to overwrite)")
    outp.parent.mkdir(parents=True, exist_ok=True)

    tmp = outp.with_name(outp.name + ".partial")
    try:
        report = restore_ipa(inp, tmp)
    except RestoreError as e:
        tmp.unlink(missing_ok=True)
        sys.exit(f"error: {e}")
    except ValueError as e:
        # Raised by patcher.py helpers, e.g. offsets not matching this binary.
        tmp.unlink(missing_ok=True)
        sys.exit(f"error: {e} (is this a MuTube IPA for YouTube 4.54.01?)")
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(outp)

    for line in report:
        print(line)
    print("Restored IPA written to:", outp)


if __name__ == "__main__":
    main()
