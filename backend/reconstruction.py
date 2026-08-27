"""Actual COLMAP/Open3D reconstruction worker.

This module deliberately has no synthetic-room fallback. If a required
reconstruction tool is missing or the images do not produce a valid model,
the job fails with that reason instead of manufacturing geometry.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Dict, Optional


class ReconstructionError(RuntimeError):
    """Raised when real reconstruction cannot be completed."""


StatusCallback = Callable[[str, str, Optional[dict]], None]


def _run(command: list[str], cwd: Path, log_path: Path) -> None:
    with log_path.open("a", encoding="utf-8") as log:
        log.write("$ " + " ".join(command) + "\n")
        completed = subprocess.run(
            command,
            cwd=cwd,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
            text=True,
        )
    if completed.returncode != 0:
        raise ReconstructionError(
            f"COLMAP stage failed with exit code {completed.returncode}. See {log_path.name}."
        )


def _require_binary(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise ReconstructionError(
            f"{name} is not installed on the reconstruction worker. Install COLMAP and retry."
        )
    return resolved


def _write_metadata(scan_dir: Path, metadata: dict) -> None:
    (scan_dir / "reconstruction.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )


def _mesh_to_glb(mesh, output_path: Path) -> str:
    """Write the measured mesh as GLB, preserving dense vertex colors when present."""
    try:
        import trimesh

        vertices = __import__("numpy").asarray(mesh.vertices)
        triangles = __import__("numpy").asarray(mesh.triangles)
        visual = None
        if mesh.has_vertex_colors():
            colors = __import__("numpy").asarray(mesh.vertex_colors)
            visual = trimesh.visual.ColorVisuals(vertex_colors=colors)
        model = trimesh.Trimesh(vertices=vertices, faces=triangles, process=False)
        if visual is not None:
            model.visual = visual
        model.export(output_path, file_type="glb")
        return "vertex-colors-from-mvs" if mesh.has_vertex_colors() else "none"
    except Exception as error:  # pragma: no cover - depends on optional native codecs
        raise ReconstructionError(f"Could not write room.glb: {error}") from error


def _build_mesh(dense_point_cloud: Path, output_path: Path) -> tuple[dict, str]:
    try:
        import numpy as np
        import open3d as o3d
    except ImportError as error:  # pragma: no cover - worker dependency check
        raise ReconstructionError("Open3D is not installed on the reconstruction worker.") from error

    point_cloud = o3d.io.read_point_cloud(str(dense_point_cloud))
    if not point_cloud.has_points() or len(point_cloud.points) < 100:
        raise ReconstructionError("COLMAP did not produce enough dense points for a room mesh.")

    point_cloud.estimate_normals()
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        point_cloud, depth=10, scale=1.1
    )
    density_values = np.asarray(densities)
    if len(density_values) > 0:
        keep = density_values > np.quantile(density_values, 0.03)
        mesh.remove_vertices_by_mask(~keep)

    # Poisson reconstruction does not always transfer colors. When it does not,
    # sample each mesh vertex from the measured MVS cloud rather than inventing a
    # material or texture.
    if point_cloud.has_colors():
        point_tree = o3d.geometry.KDTreeFlann(point_cloud)
        colors = []
        for vertex in mesh.vertices:
            _, indices, _ = point_tree.search_knn_vector_3d(vertex, 1)
            colors.append(np.asarray(point_cloud.colors)[indices[0]] if indices else [0.65, 0.65, 0.65])
        mesh.vertex_colors = o3d.utility.Vector3dVector(np.asarray(colors))

    mesh.compute_vertex_normals()
    texture_status = _mesh_to_glb(mesh, output_path)
    bounds = np.asarray(mesh.get_axis_aligned_bounding_box().get_extent()).tolist()
    return {
        "units": "meters (only when metric calibration was supplied)",
        "bounds": {"x": bounds[0], "y": bounds[1], "z": bounds[2]},
        "vertices": len(mesh.vertices),
        "triangles": len(mesh.triangles),
    }, texture_status


def run_reconstruction(
    scan_dir: Path,
    update_status: StatusCallback,
    scale_factor: float = 1.0,
) -> dict:
    """Run feature extraction through mesh/GLB export for one uploaded scan."""
    colmap = _require_binary("colmap")
    images_dir = scan_dir / "images"
    image_files = sorted(
        path for path in images_dir.iterdir() if path.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    if len(image_files) < 3:
        raise ReconstructionError("At least three overlapping camera frames are required.")

    log_path = scan_dir / "reconstruction.log"
    database = scan_dir / "database.db"
    sparse_dir = scan_dir / "sparse"
    dense_dir = scan_dir / "dense"
    sparse_dir.mkdir(exist_ok=True)
    dense_dir.mkdir(exist_ok=True)

    update_status("feature_extraction", "Extracting visual features from uploaded frames.", None)
    _run(
        [
            colmap,
            "feature_extractor",
            "--database_path",
            str(database),
            "--image_path",
            str(images_dir),
            "--ImageReader.single_camera",
            "1",
            "--ImageReader.camera_model",
            "SIMPLE_RADIAL",
        ],
        scan_dir,
        log_path,
    )

    update_status("feature_matching", "Matching overlapping frames.", None)
    _run([colmap, "exhaustive_matcher", "--database_path", str(database)], scan_dir, log_path)

    update_status("structure_from_motion", "Recovering camera poses and sparse 3D points.", None)
    _run(
        [
            colmap,
            "mapper",
            "--database_path",
            str(database),
            "--image_path",
            str(images_dir),
            "--output_path",
            str(sparse_dir),
        ],
        scan_dir,
        log_path,
    )
    model_dir = sparse_dir / "0"
    if not model_dir.exists():
        raise ReconstructionError("COLMAP could not recover a connected camera model from these frames.")

    update_status("undistortion", "Preparing calibrated images for dense reconstruction.", None)
    _run(
        [
            colmap,
            "image_undistorter",
            "--image_path",
            str(images_dir),
            "--input_path",
            str(model_dir),
            "--output_path",
            str(dense_dir),
            "--output_type",
            "COLMAP",
        ],
        scan_dir,
        log_path,
    )

    update_status("dense_reconstruction", "Building depth maps and a dense point cloud.", None)
    _run(
        [
            colmap,
            "patch_match_stereo",
            "--workspace_path",
            str(dense_dir),
            "--workspace_format",
            "COLMAP",
            "--PatchMatchStereo.geom_consistency",
            "true",
        ],
        scan_dir,
        log_path,
    )
    fused_cloud = dense_dir / "fused.ply"
    _run(
        [
            colmap,
            "stereo_fusion",
            "--workspace_path",
            str(dense_dir),
            "--workspace_format",
            "COLMAP",
            "--input_type",
            "geometric",
            "--output_path",
            str(fused_cloud),
        ],
        scan_dir,
        log_path,
    )

    update_status("mesh", "Reconstructing the measured point cloud into a surface mesh.", None)
    glb_path = scan_dir / "room.glb"
    bounds, texture_status = _build_mesh(fused_cloud, glb_path)
    if scale_factor != 1.0:
        import trimesh

        scene = trimesh.load(glb_path, force="scene")
        scene.apply_scale(scale_factor)
        scene.export(glb_path, file_type="glb")
        bounds["bounds"] = {key: value * scale_factor for key, value in bounds["bounds"].items()}

    update_status("complete", "Measured room reconstruction is ready.", None)
    result = {
        "status": "complete",
        "asset": "room.glb",
        "metadata": bounds,
        "texture": texture_status,
        "scaleFactor": scale_factor,
    }
    _write_metadata(scan_dir, result)
    return result
