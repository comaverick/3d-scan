"""FastAPI API for real camera-based room reconstruction."""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

try:
    from .reconstruction import ReconstructionError, run_reconstruction
except ImportError:  # supports `uvicorn main:app` from inside backend/
    from reconstruction import ReconstructionError, run_reconstruction


DATA_ROOT = Path(os.environ.get("SMARTSCAN_DATA_DIR", "./data")).resolve()
DATA_ROOT.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="BuildWise SmartScan reconstruction API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("SMARTSCAN_ALLOWED_ORIGINS", "*").split(","),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_locks: Dict[str, threading.Lock] = {}


class CreateScanRequest(BaseModel):
    session_id: Optional[str] = None
    device: Optional[dict] = None


class ReconstructRequest(BaseModel):
    known_marker_width_m: Optional[float] = Field(default=None, gt=0)
    scale_factor: Optional[float] = Field(default=None, gt=0)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _scan_dir(scan_id: str) -> Path:
    if not scan_id or Path(scan_id).name != scan_id:
        raise HTTPException(status_code=400, detail="Invalid scan id")
    directory = DATA_ROOT / scan_id
    if not directory.exists():
        raise HTTPException(status_code=404, detail="Scan not found")
    return directory


def _read_record(scan_dir: Path) -> dict:
    record_path = scan_dir / "scan.json"
    if not record_path.exists():
        raise HTTPException(status_code=404, detail="Scan record not found")
    return json.loads(record_path.read_text(encoding="utf-8"))


def _write_record(scan_dir: Path, record: dict) -> None:
    (scan_dir / "scan.json").write_text(json.dumps(record, indent=2), encoding="utf-8")


def _set_status(scan_id: str, status: str, message: str, result: Optional[dict] = None) -> None:
    scan_dir = DATA_ROOT / scan_id
    with _locks.setdefault(scan_id, threading.Lock()):
        record = _read_record(scan_dir)
        record["status"] = status
        record["message"] = message
        record["updatedAt"] = _now()
        if result:
            record["result"] = result
        _write_record(scan_dir, record)


def _run_job(scan_id: str, scale_factor: float) -> None:
    scan_dir = DATA_ROOT / scan_id
    try:
        result = run_reconstruction(
            scan_dir,
            lambda status, message, result: _set_status(scan_id, status, message, result),
            scale_factor=scale_factor,
        )
        _set_status(scan_id, "complete", "Measured room reconstruction is ready.", result)
    except ReconstructionError as error:
        _set_status(scan_id, "error", str(error))
    except Exception as error:  # keep unexpected worker failures visible to the client
        _set_status(scan_id, "error", f"Reconstruction worker failed: {error}")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": "real-reconstruction"}


@app.post("/api/scans", status_code=201)
def create_scan(request: CreateScanRequest) -> dict:
    scan_id = uuid.uuid4().hex
    scan_dir = DATA_ROOT / scan_id
    (scan_dir / "images").mkdir(parents=True)
    record = {
        "scanId": scan_id,
        "sessionId": request.session_id,
        "status": "created",
        "message": "Waiting for camera frames.",
        "createdAt": _now(),
        "updatedAt": _now(),
        "device": request.device or {},
        "frameCount": 0,
    }
    _write_record(scan_dir, record)
    return record


@app.post("/api/scans/{scan_id}/frames")
async def upload_frames(
    scan_id: str,
    files: List[UploadFile] = File(...),
    metadata: str = Form("[]"),
) -> dict:
    scan_dir = _scan_dir(scan_id)
    record = _read_record(scan_dir)
    try:
        metadata_rows = json.loads(metadata)
        if not isinstance(metadata_rows, list):
            raise ValueError("metadata must be an array")
    except (json.JSONDecodeError, ValueError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid frame metadata: {error}") from error

    saved = []
    for index, upload in enumerate(files):
        suffix = Path(upload.filename or "frame.jpg").suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png"}:
            suffix = ".jpg"
        filename = f"frame-{record['frameCount'] + index + 1:05d}{suffix}"
        target = scan_dir / "images" / filename
        target.write_bytes(await upload.read())
        saved.append(filename)

    manifest = scan_dir / "frames.json"
    existing = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else []
    existing.extend(metadata_rows[: len(saved)])
    manifest.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    record["frameCount"] += len(saved)
    record["status"] = "frames_uploaded"
    record["message"] = f"{record['frameCount']} camera frames stored."
    record["updatedAt"] = _now()
    _write_record(scan_dir, record)
    return {"scanId": scan_id, "frameCount": record["frameCount"], "files": saved}


@app.post("/api/scans/{scan_id}/reconstruct", status_code=202)
def start_reconstruction(
    scan_id: str,
    request: ReconstructRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    scan_dir = _scan_dir(scan_id)
    record = _read_record(scan_dir)
    if record.get("status") in {"feature_extraction", "feature_matching", "structure_from_motion", "undistortion", "dense_reconstruction", "mesh"}:
        raise HTTPException(status_code=409, detail="Reconstruction is already running")
    if record.get("frameCount", 0) < 3:
        raise HTTPException(status_code=422, detail="At least three overlapping frames are required")
    if request.known_marker_width_m is not None and request.scale_factor is None:
        raise HTTPException(
            status_code=501,
            detail="Marker size was received, but automatic ArUco/AprilTag scale recovery is not implemented yet. Supply an explicit scale_factor.",
        )
    scale_factor = request.scale_factor or 1.0
    record["status"] = "queued"
    record["message"] = "Waiting for the reconstruction worker."
    record["updatedAt"] = _now()
    _write_record(scan_dir, record)
    background_tasks.add_task(_run_job, scan_id, scale_factor)
    return {"scanId": scan_id, "status": "queued", "message": record["message"]}


@app.get("/api/scans/{scan_id}")
def get_scan(scan_id: str) -> dict:
    return _read_record(_scan_dir(scan_id))


@app.get("/api/scans/{scan_id}/room.glb")
def get_room_glb(scan_id: str) -> FileResponse:
    asset = _scan_dir(scan_id) / "room.glb"
    if not asset.exists():
        raise HTTPException(status_code=404, detail="Room GLB is not ready")
    return FileResponse(asset, media_type="model/gltf-binary", filename="room.glb")


@app.get("/api/scans/{scan_id}/metadata.json")
def get_room_metadata(scan_id: str) -> FileResponse:
    metadata = _scan_dir(scan_id) / "reconstruction.json"
    if not metadata.exists():
        raise HTTPException(status_code=404, detail="Room metadata is not ready")
    return FileResponse(metadata, media_type="application/json", filename="metadata.json")
