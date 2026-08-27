"""Actual COLMAP/Open3D reconstruction worker.

This module deliberately has no synthetic-room fallback. If a required
reconstruction tool is missing or the images do not produce a valid model,
the job fails with that reason instead of manufacturing geometry.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Dict, Optional


class ReconstructionError(RuntimeError):
    """Raised when real reconstruction cannot be completed."""


StatusCallback = Callable[[str, str, Optional[dict]], None]


def _run(command: list[str], cwd: Path, log_path: Path) -> str:
    with log_path.open("a", encoding="utf-8") as log:
        log.write("$ " + " ".join(command) + "\n")
        completed = subprocess.run(
            command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            text=True,
        )
        log.write(completed.stdout or "")
    output = completed.stdout or ""
    if completed.returncode != 0:
        output_lines = [line.strip() for line in output.splitlines() if line.strip()]
        detail = " ".join(output_lines[-4:])[:500]
        detail_suffix = f" Details: {detail}" if detail else ""
        raise ReconstructionError(
            f"COLMAP stage '{command[1]}' failed with exit code {completed.returncode}. See {log_path.name}.{detail_suffix}"
        )
    return output


def _write_log_message(log_path: Path, message: str) -> None:
    with log_path.open("a", encoding="utf-8") as log:
        log.write(message.rstrip() + "\n")


def _run_sequential_matching(colmap: str, database: Path, scan_dir: Path, log_path: Path) -> str:
    """Prefer video-order matching, then use exhaustive matching as a real fallback."""
    sequential_command = [
        colmap,
        "sequential_matcher",
        "--database_path",
        str(database),
        "--SequentialMatching.overlap",
        os.environ.get("SMARTSCAN_SEQUENTIAL_OVERLAP", "10"),
        "--SequentialMatching.loop_detection",
        "1",
    ]
    try:
        _run(sequential_command, scan_dir, log_path)
        return "sequential"
    except ReconstructionError as sequential_error:
        _write_log_message(
            log_path,
            "Sequential matching did not complete; retrying with exhaustive matching. "
            f"Reason: {sequential_error}",
        )
        _run([colmap, "exhaustive_matcher", "--database_path", str(database)], scan_dir, log_path)
        return "exhaustive-fallback"


def _run_mapper_with_fallback(
    colmap: str,
    database: Path,
    images_dir: Path,
    sparse_dir: Path,
    scan_dir: Path,
    log_path: Path,
    matching_strategy: str,
) -> str:
    mapper_command = [
        colmap,
        "mapper",
        "--database_path",
        str(database),
        "--image_path",
        str(images_dir),
        "--output_path",
        str(sparse_dir),
    ]
    try:
        _run(mapper_command, scan_dir, log_path)
        return matching_strategy
    except ReconstructionError as mapper_error:
        if matching_strategy != "sequential":
            raise
        _write_log_message(
            log_path,
            "Sequential matches did not produce a connected model; retrying mapper after exhaustive matching. "
            f"Reason: {mapper_error}",
        )
        _run([colmap, "exhaustive_matcher", "--database_path", str(database)], scan_dir, log_path)
        _run(mapper_command, scan_dir, log_path)
        return "exhaustive-fallback"


def _model_statistics(colmap: str, model_dir: Path, scan_dir: Path, log_path: Path) -> tuple[Optional[int], Optional[int]]:
    """Ask COLMAP for model counts without inventing counts if its output changes."""
    try:
        output = _run([colmap, "model_analyzer", "--path", str(model_dir)], scan_dir, log_path)
    except ReconstructionError:
        return None, None
    registered_match = re.search(r"(?:Registered images|Images)\s*[:=]\s*(\d+)", output, re.IGNORECASE)
    points_match = re.search(r"(?:Points|3D points)\s*[:=]\s*(\d+)", output, re.IGNORECASE)
    registered = int(registered_match.group(1)) if registered_match else None
    points = int(points_match.group(1)) if points_match else None
    return registered, points

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


def _clean_mesh(mesh, point_cloud, np, o3d):
    """Remove unsupported Poisson tails and tiny disconnected components."""
    if len(mesh.triangles) == 0:
        raise ReconstructionError("Dense reconstruction did not produce any usable mesh triangles.")
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_unreferenced_vertices()

    triangle_clusters, cluster_counts, _ = mesh.cluster_connected_triangles()
    labels = np.asarray(triangle_clusters)
    counts = np.asarray(cluster_counts)
    if len(counts) > 1:
        minimum_component_triangles = max(12, int(len(mesh.triangles) * 0.003))
        keep_components = {index for index, count in enumerate(counts) if count >= minimum_component_triangles}
        if not keep_components:
            keep_components = {int(np.argmax(counts))}
        mesh.remove_triangles_by_mask(np.array([label not in keep_components for label in labels]))
        mesh.remove_unreferenced_vertices()

    # Poisson can extrapolate beyond the measured MVS cloud. Crop only to an
    # expanded measured bound so openings and partial room scans stay partial.
    dense_bounds = point_cloud.get_axis_aligned_bounding_box()
    extent = np.asarray(dense_bounds.get_extent())
    tolerance = max(0.08, float(np.max(extent)) * 0.05)
    crop_min = np.asarray(dense_bounds.min_bound) - tolerance
    crop_max = np.asarray(dense_bounds.max_bound) + tolerance
    crop_bounds = o3d.geometry.AxisAlignedBoundingBox(crop_min, crop_max)
    mesh = mesh.crop(crop_bounds)
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_unreferenced_vertices()
    if len(mesh.vertices) < 20 or len(mesh.triangles) < 12:
        raise ReconstructionError(
            "Dense reconstruction produced too little connected geometry for a reliable room mesh."
        )
    mesh.compute_vertex_normals()
    return mesh


def _mesh_from_dense_cloud(point_cloud, np, o3d, method: str):
    if method == "ball_pivoting":
        distances = np.asarray(point_cloud.compute_nearest_neighbor_distance())
        distances = distances[np.isfinite(distances) & (distances > 0)]
        if len(distances) < 20:
            raise ReconstructionError("Not enough dense point spacing information for open mesh reconstruction.")
        radius = float(np.median(distances))
        radii = o3d.utility.DoubleVector([radius * 1.5, radius * 3.0, radius * 6.0])
        return o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(point_cloud, radii)
    depth = int(os.environ.get("SMARTSCAN_POISSON_DEPTH", "10"))
    depth = max(6, min(depth, 13))
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        point_cloud,
        depth=depth,
        scale=1.1,
    )
    density_values = np.asarray(densities)
    if len(density_values) > 0:
        keep = density_values > np.quantile(density_values, 0.03)
        mesh.remove_vertices_by_mask(~keep)
    return mesh


def _build_mesh(dense_point_cloud: Path, output_path: Path, mesh_method: str = "poisson") -> tuple[dict, str]:
    try:
        import numpy as np
        import open3d as o3d
    except ImportError as error:  # pragma: no cover - worker dependency check
        raise ReconstructionError("Open3D is not installed on the reconstruction worker.") from error

    point_cloud = o3d.io.read_point_cloud(str(dense_point_cloud))
    if not point_cloud.has_points() or len(point_cloud.points) < 100:
        raise ReconstructionError(
            "Not enough overlapping room detail was captured. Try scanning again with more sideways movement and overlap."
        )

    point_cloud.estimate_normals()
    normalized_method = str(mesh_method or "poisson").strip().lower()
    if normalized_method not in {"poisson", "ball_pivoting"}:
        raise ReconstructionError(
            f"Unsupported mesh method '{mesh_method}'. Use 'poisson' or 'ball_pivoting'."
        )
    mesh = _mesh_from_dense_cloud(point_cloud, np, o3d, normalized_method)
    mesh = _clean_mesh(mesh, point_cloud, np, o3d)

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

    texture_status = _mesh_to_glb(mesh, output_path)
    bounds = np.asarray(mesh.get_axis_aligned_bounding_box().get_extent()).tolist()
    return {
        "units": "meters (only when metric calibration was supplied)",
        "bounds": {"x": bounds[0], "y": bounds[1], "z": bounds[2]},
        "vertices": len(mesh.vertices),
        "triangles": len(mesh.triangles),
        "densePoints": len(point_cloud.points),
        "meshMethod": normalized_method,
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

    update_status("feature_matching", "Matching sequential room views.", None)
    matching_strategy = _run_sequential_matching(colmap, database, scan_dir, log_path)

    update_status("structure_from_motion", "Recovering camera poses and sparse 3D points.", None)
    matching_strategy = _run_mapper_with_fallback(
        colmap,
        database,
        images_dir,
        sparse_dir,
        scan_dir,
        log_path,
        matching_strategy,
    )
    model_dir = sparse_dir / "0"
    if not model_dir.exists():
        raise ReconstructionError("COLMAP could not recover a connected camera model from these frames.")
    registered_images, sparse_points = _model_statistics(colmap, model_dir, scan_dir, log_path)
    if registered_images is not None and registered_images < 3:
        raise ReconstructionError(
            f"Too few camera positions were recovered ({registered_images}). Capture more overlapping views while moving sideways."
        )
    if sparse_points is not None and sparse_points < 20:
        raise ReconstructionError(
            f"COLMAP recovered too few sparse points ({sparse_points}). Capture more textured, overlapping room detail."
        )

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
    mesh_method = os.environ.get("SMARTSCAN_MESH_METHOD", "poisson")
    bounds, texture_status = _build_mesh(fused_cloud, glb_path, mesh_method=mesh_method)
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
        "matchingStrategy": matching_strategy,
        "registeredImages": registered_images,
        "sparsePoints": sparse_points,
        "scaleFactor": scale_factor,
    }
    _write_metadata(scan_dir, result)
    return result
