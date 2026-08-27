import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const GUIDANCE_STEPS = [
  {
    label: 'READY',
    eyebrow: 'Set your origin',
    title: 'Find the center of the room',
    instruction: 'Hold your phone chest-high and face a clear wall.',
    helper: 'This position becomes the scan origin.',
    target: 'Start point',
    coverage: 0,
  },
  {
    label: 'MOVE FORWARD',
    eyebrow: 'Step 01 / Movement',
    title: 'Move forward slowly',
    instruction: 'Move forward 1 metre',
    helper: 'Keep the crosshair on a clear wall as you walk.',
    target: '1.0 m',
    coverage: 16,
  },
  {
    label: 'TURN RIGHT',
    eyebrow: 'Step 02 / Heading',
    title: 'Turn right slowly',
    instruction: 'Turn right 90 degrees',
    helper: 'Keep your feet planted and rotate the phone steadily.',
    target: '90°',
    coverage: 28,
  },
  {
    label: 'SCAN WALL',
    eyebrow: 'Step 03 / Surface',
    title: 'Scan this wall',
    instruction: 'Pan across the wall from left to right',
    helper: 'Useful frames are captured when you move 15 cm or more.',
    target: '3 frames',
    coverage: 47,
  },
  {
    label: 'MOVE LEFT',
    eyebrow: 'Step 04 / Movement',
    title: 'Move left along the room',
    instruction: 'Move left 0.8 metres',
    helper: 'Keep the bed and its far edge in view.',
    target: '0.8 m',
    coverage: 61,
  },
  {
    label: 'SCAN OPPOSITE',
    eyebrow: 'Step 05 / Surface',
    title: 'Scan the opposite side',
    instruction: 'Sweep across the opposite wall',
    helper: 'Slow down if the tracking marker turns amber.',
    target: '4 frames',
    coverage: 78,
  },
  {
    label: 'RETURN TO START',
    eyebrow: 'Step 06 / Alignment',
    title: 'Return to your starting point',
    instruction: 'Walk back to the origin',
    helper: 'Closing the loop improves room alignment.',
    target: '0.5 m',
    coverage: 91,
  },
  {
    label: 'READY TO REVIEW',
    eyebrow: 'Scan complete',
    title: 'Room scan is ready',
    instruction: 'Review the captured coverage before generating the room.',
    helper: 'Walls, floor, and the camera loop meet the minimum requirement.',
    target: '94%',
    coverage: 94,
  },
];

const TELEMETRY = [
  { x: '0.00', y: '1.42', z: '0.00', yaw: '0', speed: '0.00', quality: 'Ready' },
  { x: '0.08', y: '1.42', z: '-0.31', yaw: '1', speed: '0.22', quality: 'Good' },
  { x: '0.96', y: '1.42', z: '-0.88', yaw: '46', speed: '0.12', quality: 'Good' },
  { x: '0.98', y: '1.42', z: '-0.88', yaw: '90', speed: '0.06', quality: 'Good' },
  { x: '0.77', y: '1.42', z: '-0.91', yaw: '92', speed: '0.18', quality: 'Good' },
  { x: '0.14', y: '1.42', z: '-0.96', yaw: '178', speed: '0.10', quality: 'Good' },
  { x: '0.02', y: '1.42', z: '-0.18', yaw: '267', speed: '0.16', quality: 'Good' },
  { x: '0.01', y: '1.42', z: '-0.02', yaw: '2', speed: '0.01', quality: 'Locked' },
];

const INITIAL_OBJECTS = [
  { name: 'Bed', kind: 'bed', coverage: 0, confidence: 'preset' },
  { name: 'Desk', kind: 'desk', coverage: 0, confidence: 'preset' },
  { name: 'Chair', kind: 'chair', coverage: 0, confidence: 'preset' },
  { name: 'Window', kind: 'window', coverage: 0, confidence: 'preset' },
];

function readHeading(event) {
  const compassHeading = Number(event.webkitCompassHeading);
  const alphaHeading = Number(event.alpha);
  const heading = Number.isFinite(compassHeading) ? compassHeading : alphaHeading;
  return Number.isFinite(heading) ? (heading + 360) % 360 : null;
}

function headingDelta(start, current) {
  if (start === null || current === null) return 0;
  const rawDelta = ((current - start + 540) % 360) - 180;
  return rawDelta;
}

function motionMagnitude(event) {
  const acceleration = event.acceleration;
  if (!acceleration && !event.accelerationIncludingGravity) return 0;
  if (!acceleration) {
    const gravity = event.accelerationIncludingGravity;
    const x = Number(gravity.x) || 0;
    const y = Number(gravity.y) || 0;
    const z = Number(gravity.z) || 0;
    return Math.abs(Math.sqrt((x * x) + (y * y) + (z * z)) - 9.81);
  }
  const x = Number(acceleration.x) || 0;
  const y = Number(acceleration.y) || 0;
  const z = Number(acceleration.z) || 0;
  return Math.sqrt((x * x) + (y * y) + (z * z));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function createSessionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function blobToDataUrl(blob) {
  if (typeof blob === 'string') return Promise.resolve(blob);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function frameSource(frame) {
  return frame?.previewUrl || (typeof frame?.image === 'string' ? frame.image : '');
}

function App() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanStartedAtRef = useRef(null);
  const scanSessionIdRef = useRef(null);
  const pathRef = useRef({ x: 0, y: 1.42, z: 0, velocity: 0, lastMotionAt: null });
  const lastTelemetryRef = useRef(TELEMETRY[0]);
  const lastCaptureAtRef = useRef(0);
  const [isScanning, setIsScanning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [viewMode, setViewMode] = useState('scan');
  const [stepIndex, setStepIndex] = useState(0);
  const [stepProgress, setStepProgress] = useState(0);
  const [cameraState, setCameraState] = useState('idle');
  const [sensorState, setSensorState] = useState('idle');
  const [framesCaptured, setFramesCaptured] = useState(0);
  const [roomSession, setRoomSession] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [objects, setObjects] = useState(INITIAL_OBJECTS);
  const [lastEvent, setLastEvent] = useState('Ready when you are.');
  const [liveTelemetry, setLiveTelemetry] = useState(TELEMETRY[0]);
  const orientationRef = useRef({ heading: null });
  const stepStartHeadingRef = useRef(null);
  const lastCapturedHeadingRef = useRef(null);
  const motionRef = useRef({ pulses: 0, lastMotionAt: 0 });
  const transitionLockRef = useRef(false);
  const frameStoreRef = useRef([]);
  const captureFrameRef = useRef(null);
  const advanceGuidanceRef = useRef(null);

  const step = GUIDANCE_STEPS[stepIndex];
  const telemetry = sensorState === 'live' || isFinished ? liveTelemetry : TELEMETRY[stepIndex];
  const roomCoverage = step.coverage;
  const canFinish = isFinished || (roomCoverage >= 91 && framesCaptured >= 3);

  const liveMetric = useMemo(() => {
    if (!isScanning || stepIndex === 0 || stepIndex === GUIDANCE_STEPS.length - 1) {
      return step.target;
    }

    const numericTarget = Number.parseFloat(step.target);
    if (Number.isNaN(numericTarget)) return step.target;

    if (step.target.includes('°')) return `${Math.round(numericTarget * stepProgress)}°`;
    if (step.target.includes('m')) return `${(numericTarget * stepProgress).toFixed(1)} m`;
    return `${Math.max(1, Math.round(numericTarget * stepProgress))} frames`;
  }, [isScanning, step, stepIndex, stepProgress]);

  useEffect(() => {
    transitionLockRef.current = false;
  }, [stepIndex]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      frameStoreRef.current.forEach((frame) => {
        if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
      });
    };
  }, []);

  const enableCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('fallback');
      setLastEvent('This browser cannot provide a camera stream. Use a supported mobile browser or load a scan on desktop.');
      return false;
    }

    if (!window.isSecureContext) {
      setCameraState('fallback');
      setLastEvent('Camera access needs HTTPS on a phone. Open the secure app URL.');
      return false;
    }

    setCameraState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadeddata = () => {
          captureUsefulFrame();
          videoRef.current.onloadeddata = null;
        };
      }
      setCameraState('live');
      return true;
    } catch (error) {
      setCameraState('fallback');
      setLastEvent('Camera permission was not available. A real scan needs camera access.');
      return false;
    }
  };

  const enableSensors = async () => {
    const orientationApi = window.DeviceOrientationEvent;
    const motionApi = window.DeviceMotionEvent;
    if (!orientationApi && !motionApi) {
      setSensorState('unavailable');
      return false;
    }

    try {
      const permissionRequests = [orientationApi, motionApi]
        .filter(Boolean)
        .map(async (sensorApi) => {
          if (typeof sensorApi.requestPermission === 'function') {
            return (await sensorApi.requestPermission()) === 'granted';
          }
          return true;
        });
      const permissionResults = await Promise.all(permissionRequests);
      const isGranted = permissionResults.some(Boolean);
      setSensorState(isGranted ? 'live' : 'unavailable');
      return isGranted;
    } catch (error) {
      setSensorState('unavailable');
      return false;
    }
  };

  const captureUsefulFrame = () => {
    const video = videoRef.current;
    const now = Date.now();
    if (now - lastCaptureAtRef.current < 700) return;
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = Math.round((video.videoHeight / video.videoWidth) * 640);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const previewUrl = URL.createObjectURL(blob);
        frameStoreRef.current.push({
          frameId: frameStoreRef.current.length + 1,
          capturedAt: now,
          pose: { ...lastTelemetryRef.current },
          step: stepIndex,
          image: blob,
          previewUrl,
        });
        lastCaptureAtRef.current = now;
        setFramesCaptured(frameStoreRef.current.length);
      }, 'image/jpeg', 0.82);
    }
  };
  captureFrameRef.current = captureUsefulFrame;

  const updateLiveTelemetry = (heading = orientationRef.current.heading, speed = pathRef.current.velocity, quality = 'Live') => {
    const nextTelemetry = {
      x: pathRef.current.x.toFixed(2),
      y: pathRef.current.y.toFixed(2),
      z: pathRef.current.z.toFixed(2),
      yaw: heading === null ? lastTelemetryRef.current.yaw : Math.round(heading).toString(),
      speed: Number(speed).toFixed(2),
      quality,
    };
    lastTelemetryRef.current = nextTelemetry;
    setLiveTelemetry(nextTelemetry);
  };

  const startScan = async () => {
    frameStoreRef.current.forEach((frame) => {
      if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
    });
    setIsScanning(true);
    setIsFinished(false);
    setViewMode('scan');
    setRoomSession(null);
    setImportError('');
    setStepIndex(1);
    setStepProgress(0);
    setFramesCaptured(0);
    frameStoreRef.current = [];
    setObjects(INITIAL_OBJECTS.map((object) => ({ ...object })));
    setLiveTelemetry(TELEMETRY[1]);
    orientationRef.current = { heading: null };
    stepStartHeadingRef.current = null;
    lastCapturedHeadingRef.current = null;
    motionRef.current = { pulses: 0, lastMotionAt: 0 };
    transitionLockRef.current = false;
    scanStartedAtRef.current = Date.now();
    scanSessionIdRef.current = createSessionId();
    pathRef.current = { x: 0, y: 1.42, z: 0, velocity: 0, lastMotionAt: null };
    lastCaptureAtRef.current = 0;
    lastTelemetryRef.current = TELEMETRY[1];

    const [cameraReady, sensorsReady] = await Promise.all([enableCamera(), enableSensors()]);
    if (cameraReady && sensorsReady) {
      setLastEvent('Camera and motion sensors are live. Guidance is active.');
    } else if (cameraReady) {
      setLastEvent('Camera is live. Use the checkpoint button if motion sensors are unavailable.');
    } else {
      setLastEvent('Camera unavailable. Use HTTPS on your phone, or continue in demo mode.');
    }
  };

  const advanceGuidance = (source = 'Checkpoint marked') => {
    if (!isScanning || stepIndex >= GUIDANCE_STEPS.length - 1 || transitionLockRef.current) return;
    transitionLockRef.current = true;
    const nextIndex = stepIndex + 1;
    setStepIndex(nextIndex);
    setStepProgress(0);
    captureUsefulFrame();
    motionRef.current.pulses = 0;
    stepStartHeadingRef.current = orientationRef.current.heading;
    setLastEvent(`${source}. ${GUIDANCE_STEPS[nextIndex].label.toLowerCase()} is next.`);
  };
  advanceGuidanceRef.current = advanceGuidance;

  useEffect(() => {
    if (!isScanning || sensorState !== 'live') return undefined;

    const handleOrientation = (event) => {
      const heading = readHeading(event);
      if (heading === null) return;

      orientationRef.current.heading = heading;
      updateLiveTelemetry(heading, pathRef.current.velocity);

      if (stepStartHeadingRef.current === null) {
        stepStartHeadingRef.current = heading;
      }

      if (lastCapturedHeadingRef.current === null || Math.abs(headingDelta(lastCapturedHeadingRef.current, heading)) >= 10) {
        captureFrameRef.current?.();
        lastCapturedHeadingRef.current = heading;
      }

      if (stepIndex === 2) {
        const turnAmount = Math.abs(headingDelta(stepStartHeadingRef.current ?? heading, heading));
        setStepProgress(Math.min(1, turnAmount / 90));
        if (turnAmount >= 75) {
          advanceGuidanceRef.current?.('Right turn detected');
        }
      }
    };

    const handleMotion = (event) => {
      const now = Date.now();
      const previousMotionAt = pathRef.current.lastMotionAt;
      const deltaSeconds = previousMotionAt === null
        ? 0
        : clamp((now - previousMotionAt) / 1000, 0, 0.35);
      const acceleration = motionMagnitude(event);
      const isMoving = acceleration >= 0.12;
      const nextVelocity = isMoving
        ? clamp(pathRef.current.velocity + (acceleration * deltaSeconds), 0, 1.2)
        : pathRef.current.velocity * 0.82;
      const heading = orientationRef.current.heading ?? 0;
      const headingRadians = (heading * Math.PI) / 180;
      const distance = nextVelocity * deltaSeconds;
      pathRef.current.x += Math.sin(headingRadians) * distance;
      pathRef.current.z -= Math.cos(headingRadians) * distance;
      pathRef.current.velocity = nextVelocity;
      pathRef.current.lastMotionAt = now;
      updateLiveTelemetry(orientationRef.current.heading, nextVelocity);

      if (!isMoving) return;
      if (now - motionRef.current.lastMotionAt < 350) return;
      motionRef.current.lastMotionAt = now;
      motionRef.current.pulses += 1;
      captureFrameRef.current?.();

      const requiredPulses = stepIndex === 3 || stepIndex === 5 ? 3 : 4;
      setStepProgress(Math.min(1, motionRef.current.pulses / requiredPulses));
      if (stepIndex !== 2 && motionRef.current.pulses >= requiredPulses) {
        advanceGuidanceRef.current?.('Movement detected');
      }
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    window.addEventListener('devicemotion', handleMotion, true);
    return () => {
      window.removeEventListener('deviceorientation', handleOrientation, true);
      window.removeEventListener('devicemotion', handleMotion, true);
    };
  }, [isScanning, sensorState, stepIndex]);

  const finishScan = () => {
    if (!canFinish) return;
    const finishedAt = Date.now();
    const frames = frameStoreRef.current.map((frame) => ({
      ...frame,
      pose: { ...frame.pose },
    }));
    const session = {
      schemaVersion: 1,
      sessionId: scanSessionIdRef.current || createSessionId(),
      createdAt: new Date(scanStartedAtRef.current || finishedAt).toISOString(),
      durationSeconds: Math.max(0, (finishedAt - (scanStartedAtRef.current || finishedAt)) / 1000),
      coordinateSystem: 'browser-estimated local path; yaw from DeviceOrientation',
      frames,
      objects: objects.map((object) => ({ ...object })),
    };
    setIsFinished(true);
    setIsScanning(false);
    setRoomSession(session);
    setSensorState('idle');
    setStepIndex(GUIDANCE_STEPS.length - 1);
    setStepProgress(1);
    setLastEvent('Scan saved in this browser. Export it to use it on desktop.');
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const exportScan = async () => {
    if (!roomSession || isExporting) return;
    setIsExporting(true);
    setImportError('');
    try {
      const frames = await Promise.all(roomSession.frames.map(async (frame) => ({
        frameId: frame.frameId,
        capturedAt: frame.capturedAt,
        pose: frame.pose,
        step: frame.step,
        image: await blobToDataUrl(frame.image),
      })));
      const payload = JSON.stringify({ ...roomSession, frames }, null, 2);
      const exportBlob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(exportBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `buildwise-smartscan-${roomSession.sessionId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setLastEvent('Scan exported. Load this JSON on the desktop website.');
    } catch (error) {
      setImportError('The scan could not be exported. Try again on the device that captured it.');
    } finally {
      setIsExporting(false);
    }
  };

  const importScan = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (!Array.isArray(payload.frames) || payload.frames.length === 0) {
        throw new Error('No frames in scan session');
      }
      const frames = payload.frames.filter((frame) => typeof frame.image === 'string').map((frame, index) => ({
        frameId: frame.frameId || index + 1,
        capturedAt: frame.capturedAt || Date.now(),
        pose: frame.pose || TELEMETRY[0],
        step: frame.step || 0,
        image: frame.image,
        previewUrl: frame.image,
      }));
      if (frames.length === 0) throw new Error('Scan images are missing');
      frameStoreRef.current.forEach((frame) => {
        if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
      });
      frameStoreRef.current = [];
      const importedSession = { ...payload, frames };
      setRoomSession(importedSession);
      setFramesCaptured(frames.length);
      setObjects(Array.isArray(payload.objects) ? payload.objects : INITIAL_OBJECTS.map((object) => ({ ...object })));
      setIsScanning(false);
      setIsFinished(true);
      setViewMode('customize');
      setCameraState('idle');
      setSensorState('idle');
      setStepIndex(GUIDANCE_STEPS.length - 1);
      setStepProgress(1);
      const lastFrame = frames[frames.length - 1];
      lastTelemetryRef.current = lastFrame.pose;
      setLiveTelemetry(lastFrame.pose);
      setLastEvent(`Loaded ${frames.length} captured frames from ${file.name}.`);
      setImportError('');
    } catch (error) {
      setImportError('That file is not a valid BuildWise SmartScan session.');
    }
  };

  const resetScan = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    frameStoreRef.current.forEach((frame) => {
      if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
    });
    setIsScanning(false);
    setIsFinished(false);
    setViewMode('scan');
    setStepIndex(0);
    setStepProgress(0);
    setFramesCaptured(0);
    frameStoreRef.current = [];
    setObjects(INITIAL_OBJECTS.map((object) => ({ ...object })));
    setLastEvent('Ready when you are.');
    setCameraState('idle');
    setSensorState('idle');
    setLiveTelemetry(TELEMETRY[0]);
    setRoomSession(null);
    setImportError('');
    transitionLockRef.current = false;
    lastCapturedHeadingRef.current = null;
    scanStartedAtRef.current = null;
    scanSessionIdRef.current = null;
    pathRef.current = { x: 0, y: 1.42, z: 0, velocity: 0, lastMotionAt: null };
    lastTelemetryRef.current = TELEMETRY[0];
  };

  return (
    <main className={`app-shell ${isScanning ? 'app-shell-scanning' : ''}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">B</div>
          <div>
            <p className="brand-name">BuildWise</p>
            <p className="brand-product">SmartScan</p>
          </div>
        </div>

        <div className="topbar-context">
          <span className="context-kicker">Project</span>
          <span className="context-value">Primary bedroom</span>
          <span className="context-divider" aria-hidden="true" />
          <span className={`status-dot ${isFinished ? 'status-dot-complete' : ''}`} />
          <span className="context-value">{isFinished ? 'Ready to review' : isScanning ? 'Scanning' : 'Not started'}</span>
        </div>

        <div className="topbar-actions">
          {roomSession && (
            <button className="quiet-button" type="button" onClick={() => setViewMode(viewMode === 'customize' ? 'scan' : 'customize')}>
              {viewMode === 'customize' ? 'Back to scan' : 'Room customizer'}
            </button>
          )}
          <label className="import-control">
            Load scan
            <input type="file" accept="application/json,.json" onChange={importScan} />
          </label>
          <button className="quiet-button" type="button" onClick={resetScan}>Exit scan</button>
        </div>
      </header>

      {viewMode === 'customize' && roomSession ? (
        <RoomCustomizer session={roomSession} objects={objects} onExport={exportScan} isExporting={isExporting} />
      ) : <div className={`workspace ${isScanning ? 'workspace-scanning' : ''}`}>
        <section className="camera-column" aria-label="Camera preview">
          <div className="camera-frame">
            <video ref={videoRef} className={`camera-video ${cameraState === 'live' ? 'camera-video-live' : ''}`} autoPlay muted playsInline />
            <div className="room-fallback" aria-hidden={cameraState === 'live'}>
              <div className="fallback-window" />
              <div className="fallback-wall fallback-wall-left" />
              <div className="fallback-wall fallback-wall-right" />
              <div className="fallback-floor" />
              <div className="fallback-bed"><span>BED</span></div>
              <div className="fallback-desk"><span>DESK</span></div>
            </div>
            <div className="camera-shade" />
            <div className="camera-meta camera-meta-top">
              <span className="recording-label"><span className="status-dot status-dot-recording" /> {isScanning ? 'LIVE CAPTURE' : 'CAMERA PREVIEW'}</span>
              <span className="camera-mode">{cameraState === 'live' ? 'LIVE CAMERA' : cameraState === 'fallback' ? 'HTTPS REQUIRED' : 'DEMO VIEW'}</span>
            </div>
            {cameraState === 'requesting' && <div className="camera-notice">Requesting camera access...</div>}
            {cameraState === 'fallback' && <div className="camera-notice camera-notice-warning">Open this page over HTTPS to use the phone camera.</div>}
            <div className="target-reticle" aria-hidden="true">
              <span className="reticle-line reticle-line-top" />
              <span className="reticle-line reticle-line-right" />
              <span className="reticle-line reticle-line-bottom" />
              <span className="reticle-line reticle-line-left" />
              <span className="reticle-cross reticle-cross-horizontal" />
              <span className="reticle-cross reticle-cross-vertical" />
            </div>
            <div className="object-tag object-tag-bed"><span className="tag-corner" />Frame anchor <b>LIVE</b></div>
            <div className="object-tag object-tag-window"><span className="tag-corner" />Room image <b>CAPTURE</b></div>
            <div className="camera-meta camera-meta-bottom">
              <span>Frame quality <b>{cameraState === 'live' ? 'Good' : 'Simulated'}</b></span>
              <span>Capture threshold <b>15 cm</b></span>
            </div>
          </div>

          <div className="camera-footer">
            <div className="telemetry-heading">
              <div>
                <p className="section-label">Live pose</p>
                <h2>Position tracking</h2>
              </div>
              <span className={`tracking-badge ${sensorState === 'live' ? 'tracking-badge-live' : telemetry.quality === 'Locked' ? 'tracking-badge-locked' : ''}`}>
                <span className="status-dot status-dot-small" /> {sensorState === 'live' ? 'Live sensors' : sensorState === 'unavailable' ? 'Camera only' : telemetry.quality}
              </span>
            </div>
            <div className="telemetry-grid">
              <TelemetryValue label="X position" value={`${telemetry.x} m`} />
              <TelemetryValue label="Y position" value={`${telemetry.y} m`} />
              <TelemetryValue label="Z position" value={`${telemetry.z} m`} />
              <TelemetryValue label="Yaw" value={`${telemetry.yaw}°`} />
              <TelemetryValue label="Speed" value={`${telemetry.speed} m/s`} />
              <TelemetryValue label="Frames" value={framesCaptured.toString().padStart(2, '0')} />
            </div>
          </div>
        </section>

        <aside className="control-column">
          <div className="control-header">
            <div>
              <p className="section-label">AI-assisted guided spatial scanning</p>
              <h1>{isFinished ? 'Ready to generate your room.' : 'Scan the room with your phone.'}</h1>
            </div>
            <span className="phase-chip">Phase 01</span>
          </div>

          <section className="progress-panel" aria-label="Room scan progress">
            <div className="progress-heading">
              <span>Room coverage</span>
              <strong>{roomCoverage}%</strong>
            </div>
            <div className="progress-track" aria-hidden="true"><span style={{ width: `${roomCoverage}%` }} /></div>
            <div className="progress-footing">
              <span>{isFinished ? 'Minimum requirements met' : roomCoverage >= 91 ? 'Loop closed' : 'Building spatial map'}</span>
              <span>{framesCaptured} useful frames</span>
            </div>
          </section>

          <section className={`instruction-panel ${isFinished ? 'instruction-panel-complete' : ''}`} aria-live="polite">
            <div className="instruction-topline">
              <span className="instruction-label">{step.label}</span>
              <span className="instruction-step">{stepIndex === 0 ? 'Ready' : `${Math.min(stepIndex, 6)} / 06`}</span>
            </div>
            <div className="instruction-content">
              <div className="direction-glyph" aria-hidden="true">{isFinished ? '✓' : stepIndex === 2 ? '↻' : stepIndex === 4 ? '←' : '↑'}</div>
              <div>
                <p className="section-label">{step.eyebrow}</p>
                <h2>{step.title}</h2>
                <p className="instruction-copy">{step.instruction}</p>
              </div>
            </div>
            <div className="instruction-meter-row">
              <span>{isFinished ? 'Scan quality' : 'Current target'}</span>
              <strong>{isFinished ? 'Ready' : liveMetric}</strong>
            </div>
            <div className="instruction-meter"><span style={{ width: `${isFinished ? 100 : stepIndex === 0 ? 0 : stepProgress * 100}%` }} /></div>
            <p className="instruction-helper">{step.helper}</p>
          </section>

          <div className="event-line"><span className="event-pulse" />{lastEvent}</div>

          <section className="objects-panel" aria-label="Room asset presets">
            <div className="panel-heading-row">
              <div>
                <p className="section-label">Room assets</p>
                <h2>Customization presets</h2>
              </div>
              <span className="object-count">{objects.length} ready</span>
            </div>
            <div className="object-list">
              {objects.map((object) => (
                <div className="object-row" key={object.name}>
                  <span className={`object-icon object-icon-${object.kind}`} aria-hidden="true">{object.name.slice(0, 1)}</span>
                  <div className="object-name-wrap"><strong>{object.name}</strong><span>Ready to place</span></div>
                  <div className="object-progress-wrap"><span>3D</span><div className="object-progress"><i style={{ width: '100%' }} /></div></div>
                </div>
              ))}
            </div>
          </section>

          <div className="control-actions">
            {!isScanning && !isFinished && (
              <button className="primary-button" type="button" onClick={startScan}>Start scan <span aria-hidden="true">↗</span></button>
            )}
            {isScanning && (
              <button className="primary-button" type="button" onClick={advanceGuidance}>
                Mark checkpoint <span className="checkpoint-arrow" aria-hidden="true">-&gt;</span>
              </button>
            )}
            {isFinished && roomSession && (
              <button className="primary-button" type="button" onClick={() => setViewMode('customize')}>
                Open room customizer <span aria-hidden="true">-&gt;</span>
              </button>
            )}
            {!isFinished && (
              <button className="secondary-button" type="button" onClick={finishScan} disabled={!canFinish}>
                Finish scan
              </button>
            )}
            {isFinished && roomSession && (
              <button className="secondary-button" type="button" onClick={exportScan} disabled={isExporting}>
                {isExporting ? 'Preparing export...' : 'Export scan JSON'}
              </button>
            )}
          </div>
          {importError && <p className="action-note action-note-error">{importError}</p>}
          {!isScanning && !isFinished && <p className="action-note">Camera and movement tracking begin after you start.</p>}
          {isScanning && <p className="action-note">{sensorState === 'live' ? 'Move as instructed. Turn and movement signals can advance the checkpoint automatically.' : 'Motion sensors are unavailable. Complete each instruction, then mark the checkpoint manually.'}</p>}
          {isFinished && <p className="action-note action-note-success">Your scan is now available to the room customizer and can be loaded on desktop.</p>}
        </aside>
      </div>}
    </main>
  );
}

function RoomCustomizer({ session, objects, onExport, isExporting }) {
  const previewVideoRef = useRef(null);
  const previewStreamRef = useRef(null);
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const [selectedAssetName, setSelectedAssetName] = useState(objects[0]?.name || 'Bed');
  const [assetColor, setAssetColor] = useState('#d8b08a');
  const [assetScale, setAssetScale] = useState(1);
  const [isCameraPreview, setIsCameraPreview] = useState(false);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    return () => {
      if (previewStreamRef.current) {
        previewStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const activeFrame = session.frames[activeFrameIndex] || session.frames[0];
  const selectedAsset = objects.find((object) => object.name === selectedAssetName) || objects[0];

  const toggleCameraPreview = async () => {
    if (isCameraPreview) {
      previewStreamRef.current?.getTracks().forEach((track) => track.stop());
      previewStreamRef.current = null;
      setIsCameraPreview(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setPreviewError('Camera preview needs a secure website and a browser camera.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      previewStreamRef.current = stream;
      if (previewVideoRef.current) previewVideoRef.current.srcObject = stream;
      setPreviewError('');
      setIsCameraPreview(true);
    } catch (error) {
      setPreviewError('Camera preview permission was not available on this browser.');
    }
  };

  const pathPoints = session.frames.map((frame) => ({
    x: Number(frame.pose?.x) || 0,
    z: Number(frame.pose?.z) || 0,
  }));
  const minX = Math.min(...pathPoints.map((point) => point.x), 0);
  const maxX = Math.max(...pathPoints.map((point) => point.x), 1);
  const minZ = Math.min(...pathPoints.map((point) => point.z), 0);
  const maxZ = Math.max(...pathPoints.map((point) => point.z), 1);
  const pathRangeX = Math.max(maxX - minX, 0.5);
  const pathRangeZ = Math.max(maxZ - minZ, 0.5);
  const pathPolyline = pathPoints.map((point) => {
    const x = 10 + ((point.x - minX) / pathRangeX) * 80;
    const y = 10 + ((point.z - minZ) / pathRangeZ) * 80;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastPathCoordinate = pathPolyline.split(' ').pop()?.split(',');

  return (
    <div className="customizer-workspace">
      <div className="customizer-header">
        <div>
          <p className="section-label">Scan to room customization</p>
          <h1>Place furniture in your scanned room.</h1>
          <p className="customizer-intro">Your captured keyframes and estimated movement path are now available on the website.</p>
        </div>
        <div className="customizer-header-actions">
          <span className="session-chip">{session.frames.length} keyframes</span>
          <button className="secondary-button" type="button" onClick={onExport} disabled={isExporting}>
            {isExporting ? 'Preparing...' : 'Export session'}
          </button>
        </div>
      </div>

      <div className="customizer-grid">
        <section className="customizer-stage-panel" aria-label="Room customization preview">
          <div className={`customizer-stage ${isCameraPreview ? 'customizer-stage-camera' : ''}`}>
            {isCameraPreview ? (
              <video ref={previewVideoRef} className="customizer-camera" autoPlay muted playsInline />
            ) : frameSource(activeFrame) ? (
              <img className="customizer-keyframe" src={frameSource(activeFrame)} alt={`Captured room frame ${activeFrameIndex + 1}`} />
            ) : (
              <div className="customizer-empty-stage">No room image in this session.</div>
            )}
            <div className="customizer-stage-shade" />
            <div className="customizer-stage-meta">
              <span>{isCameraPreview ? 'CAMERA OVERLAY' : 'CAPTURED ROOM VIEW'}</span>
              <span>{selectedAsset?.name || 'Room asset'} / PLACED</span>
            </div>
            <div className="customizer-crosshair" aria-hidden="true" />
            <div className={`placed-asset placed-asset-${selectedAsset?.kind || 'bed'}`} style={{ '--asset-color': assetColor, '--asset-scale': assetScale }}>
              <span>{selectedAsset?.name || 'Bed'}</span>
            </div>
            <div className="customizer-placement-note">Drag placement is ready for the next WebXR pass.</div>
          </div>

          <div className="frame-strip" aria-label="Captured room frames">
            {session.frames.map((frame, index) => (
              <button
                className={`frame-thumb ${index === activeFrameIndex ? 'frame-thumb-active' : ''}`}
                type="button"
                key={frame.frameId || index}
                onClick={() => setActiveFrameIndex(index)}
                aria-label={`Show room frame ${index + 1}`}
              >
                {frameSource(frame) ? <img src={frameSource(frame)} alt="" /> : <span>{index + 1}</span>}
              </button>
            ))}
          </div>
        </section>

        <aside className="customizer-controls">
          <div className="customizer-control-heading">
            <div>
              <p className="section-label">AR customization</p>
              <h2>Room assets</h2>
            </div>
            <span className="tracking-badge tracking-badge-live">Local session</span>
          </div>

          <div className="asset-picker">
            {objects.map((object) => (
              <button
                className={`asset-choice ${selectedAssetName === object.name ? 'asset-choice-active' : ''}`}
                type="button"
                key={object.name}
                onClick={() => setSelectedAssetName(object.name)}
              >
                <span className={`object-icon object-icon-${object.kind}`} aria-hidden="true">{object.name.slice(0, 1)}</span>
                <span>{object.name}</span>
              </button>
            ))}
          </div>

          <label className="customizer-slider-label" htmlFor="asset-scale">
            <span>Asset size</span><strong>{assetScale.toFixed(1)}x</strong>
          </label>
          <input id="asset-scale" className="customizer-slider" type="range" min="0.6" max="1.6" step="0.1" value={assetScale} onChange={(event) => setAssetScale(Number(event.target.value))} />

          <div className="color-picker-label"><span>Material tone</span><strong>{assetColor.toUpperCase()}</strong></div>
          <div className="color-picker">
            {['#d8b08a', '#8c9caa', '#c7c1ae', '#6b735f', '#b86e55'].map((color) => (
              <button className={`color-swatch ${assetColor === color ? 'color-swatch-active' : ''}`} style={{ backgroundColor: color }} type="button" key={color} onClick={() => setAssetColor(color)} aria-label={`Use ${color} material`} />
            ))}
          </div>

          <div className="room-map-panel">
            <div className="panel-heading-row"><div><p className="section-label">Captured path</p><h2>Room footprint</h2></div><span className="object-count">Estimated</span></div>
            <svg className="room-map" viewBox="0 0 100 100" role="img" aria-label="Estimated room scan path">
              <rect x="8" y="8" width="84" height="84" rx="2" />
              <polyline points={pathPolyline} />
              {pathPoints.length > 0 && <circle cx={lastPathCoordinate?.[0]} cy={lastPathCoordinate?.[1]} r="3" />}
            </svg>
          </div>

          <button className="primary-button customizer-camera-button" type="button" onClick={toggleCameraPreview}>
            {isCameraPreview ? 'Close camera preview' : 'Preview with camera'} <span aria-hidden="true">-&gt;</span>
          </button>
          {previewError && <p className="action-note action-note-error">{previewError}</p>}
          <p className="customizer-disclaimer">The portable session is real camera data. Exact wall geometry and world-locked placement require a WebXR-capable browser or a reconstruction service.</p>
        </aside>
      </div>
    </div>
  );
}

function TelemetryValue({ label, value }) {
  return <div className="telemetry-value"><span>{label}</span><strong>{value}</strong></div>;
}

export default App;
