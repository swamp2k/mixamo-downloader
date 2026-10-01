#!/usr/bin/env python3
"""Batch-convert Mixamo FBX characters to GLB using Blender."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    script_args = argv[argv.index("--") + 1 :] if "--" in argv else []

    parser = argparse.ArgumentParser(
        description="Convert every FBX in a directory to one GLB per file."
    )
    parser.add_argument("--input", required=True, type=Path, help="Directory containing FBX files.")
    parser.add_argument("--output", required=True, type=Path, help="Directory for converted GLB files.")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing GLB files.")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Optional manifest path (default: <output>/conversion-manifest.json).",
    )
    return parser.parse_args(script_args)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(source: Path) -> None:
    result = bpy.ops.import_scene.fbx(
        filepath=str(source),
        use_anim=True,
        use_custom_normals=True,
        use_image_search=True,
        use_custom_props=True,
        bake_space_transform=False,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"FBX import did not finish: {sorted(result)}")


def export_glb(destination: Path) -> None:
    result = bpy.ops.export_scene.gltf(
        filepath=str(destination),
        export_format="GLB",
        export_materials="EXPORT",
        export_skins=True,
        export_animations=True,
        export_morph=True,
        export_yup=True,
        export_apply=False,
        export_cameras=False,
        export_lights=False,
        use_selection=False,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"glTF export did not finish: {sorted(result)}")


def convert_one(source: Path, destination: Path, overwrite: bool) -> dict:
    if destination.exists() and not overwrite:
        return {
            "source": str(source),
            "destination": str(destination),
            "status": "skipped",
            "reason": "destination-exists",
            "bytes": destination.stat().st_size,
        }

    reset_scene()
    import_fbx(source)

    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_destination = destination.with_name(f"{destination.stem}.tmp{destination.suffix}")
    if temp_destination.exists():
        temp_destination.unlink()

    try:
        export_glb(temp_destination)
        size = temp_destination.stat().st_size
        if size <= 0:
            raise RuntimeError("GLB export produced an empty file.")
        os.replace(temp_destination, destination)
    finally:
        if temp_destination.exists():
            temp_destination.unlink()

    return {
        "source": str(source),
        "destination": str(destination),
        "status": "converted",
        "bytes": destination.stat().st_size,
    }


def main() -> int:
    args = parse_args()
    input_dir = args.input.resolve()
    output_dir = args.output.resolve()
    manifest_path = (args.manifest or (output_dir / "conversion-manifest.json")).resolve()

    if not input_dir.is_dir():
        print(f"ERROR: input directory does not exist: {input_dir}", file=sys.stderr)
        return 2

    sources = sorted(
        (path for path in input_dir.iterdir() if path.is_file() and path.suffix.lower() == ".fbx"),
        key=lambda path: path.name.lower(),
    )

    output_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "startedAt": utc_now(),
        "inputDir": str(input_dir),
        "outputDir": str(output_dir),
        "blenderVersion": bpy.app.version_string,
        "files": [],
    }

    print("Mixamo FBX -> GLB")
    print(f"Blender: {bpy.app.version_string}")
    print(f"Input:   {input_dir}")
    print(f"Output:  {output_dir}")
    print(f"Found:   {len(sources)} FBX file(s)")

    failures = 0

    for index, source in enumerate(sources, start=1):
        destination = output_dir / f"{source.stem}.glb"
        print(f"[{index}/{len(sources)}] {source.name}")

        try:
            record = convert_one(source, destination, args.overwrite)
            manifest["files"].append(record)
            if record["status"] == "converted":
                print(f"  saved: {destination.name} ({record['bytes']} bytes)")
            else:
                print(f"  skip:  {destination.name}")
        except Exception as error:
            failures += 1
            manifest["files"].append(
                {
                    "source": str(source),
                    "destination": str(destination),
                    "status": "failed",
                    "error": str(error),
                    "traceback": traceback.format_exc(),
                }
            )
            print(f"  FAILED: {error}", file=sys.stderr)
        finally:
            manifest["updatedAt"] = utc_now()
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )

    converted = sum(item["status"] == "converted" for item in manifest["files"])
    skipped = sum(item["status"] == "skipped" for item in manifest["files"])
    manifest["finishedAt"] = utc_now()
    manifest["summary"] = {
        "total": len(sources),
        "converted": converted,
        "skipped": skipped,
        "failed": failures,
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print("\n=== Summary ===")
    print(f"Converted: {converted}")
    print(f"Skipped:   {skipped}")
    print(f"Failed:    {failures}")
    print(f"Manifest:  {manifest_path}")

    return 2 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
