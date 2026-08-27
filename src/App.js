import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import './App.css';

const GUIDANCE_STEPS = [
  {
    kind: 'origin',
    direction: '↑',
    label: 'STARTING VIEW',
    eyebrow: 'Set your starting view',
    title: 'Face the open side of the room',
    instruction: 'Hold your phone chest-high and aim at a clear wall or corner.',
    helper: 'Choose a well-lit view with fixed edges. This is the reference for the room loop.',
    target: 'Reference view',
    coverage: 0,
  },
  {
    kind: 'movement',
    direction: '↑',
    label: 'DEPTH PASS',
    eyebrow: 'Move through the room',
    title: 'Move forward slowly',
    instruction: 'Walk a few steady steps into the open space.',
    helper: 'Keep the phone level and leave the walls, floor, and ceiling edges in view.',
    target: 'Movement cues',
    progressUnit: 'movement cues',
    requiredPulses: 4,
    coverage: 16,
  },
  {
    kind: 'turn',
    direction: '↻',
    label: 'NEXT WALL',
    eyebrow: 'Change direction',
    title: 'Turn toward the next wall',
    instruction: 'Keep your feet planted and rotate until the next wall is centered.',
    helper: 'Turn slowly so neighboring views overlap.',
    target: 'Turn',
    progressUnit: 'deg',
    turnDegrees: 75,
    coverage: 28,
  },
  {
    kind: 'surface',
    direction: '→',
    label: 'WALL PASS',
    eyebrow: 'Capture this side',
    title: 'Sweep across the wall',
    instruction: 'Pan from one side to the other at a steady pace.',
    helper: 'Keep part of the previous view visible as you sweep.',
    target: 'Surface cues',
    progressUnit: 'surface cues',
    requiredPulses: 3,
    coverage: 47,
  },
  {
    kind: 'movement',
    direction: '←',
    label: 'ROOM PASS',
    eyebrow: 'Follow the room edge',
    title: 'Move along the open side',
    instruction: 'Take a few slow steps along the room perimeter.',
    helper: 'Aim for the next corner and keep the floor line visible.',
    target: 'Movement cues',
    progressUnit: 'movement cues',
    requiredPulses: 4,
    coverage: 61,
  },
  {
    kind: 'surface',
    direction: '←',
    label: 'OPPOSITE PASS',
    eyebrow: 'Capture the far side',
    title: 'Sweep across the opposite wall',
    instruction: 'Pan across the far side of the room.',
    helper: 'Include corners and the floor line before moving on.',
    target: 'Surface cues',
    progressUnit: 'surface cues',
    requiredPulses: 3,
    coverage: 78,
  },
  {
    kind: 'return',
    direction: '↺',
    label: 'CLOSE LOOP',
    eyebrow: 'Align the scan',
    title: 'Return to the starting view',
    instruction: 'Walk back to your starting point and face the original direction.',
    helper: 'Closing the loop helps the simulator connect the captured views.',
    target: 'Movement cues',
    progressUnit: 'movement cues',
    requiredPulses: 4,
    coverage: 91,
  },
  {
    kind: 'complete',
    direction: '✓',
    label: 'SCAN READY',
    eyebrow: 'Review your room',
    title: 'Your room scan is ready',
    instruction: 'Open the simulator to review the captured views and place furniture.',
    helper: 'If a wall or corner is missing, return to scanning and capture that area before customizing.',
    target: 'Ready',
    coverage: 100,
  },
];

const FINAL_SCAN_STEP_INDEX = GUIDANCE_STEPS.length - 1;

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
  const nextStep = GUIDANCE_STEPS[Math.min(stepIndex + 1, FINAL_SCAN_STEP_INDEX)];
  const stepCoverage = step.coverage || 0;
  const nextStepCoverage = nextStep.coverage ?? 100;
  const roomCoverage = isFinished
    ? 100
    : Math.round(stepCoverage + ((isScanning ? stepProgress : 0) * (nextStepCoverage - stepCoverage)));
  const canFinish = isFinished || (stepIndex === FINAL_SCAN_STEP_INDEX && framesCaptured >= 3);

  const finishHint = useMemo(() => {
    if (isFinished) return 'Scan complete. Review the captured room in the simulator.';
    if (stepIndex < FINAL_SCAN_STEP_INDEX) return 'Follow the direction card to close the room loop.';
    if (framesCaptured < 3) return 'Capture at least 3 useful views before finishing.';
    return 'The scan is ready. Finish it to open the room simulator.';
  }, [framesCaptured, isFinished, stepIndex]);

  const instructionText = useMemo(() => {
    if (!isScanning || sensorState === 'live' || stepIndex === FINAL_SCAN_STEP_INDEX) {
      return step.instruction;
    }
    return `${step.instruction} When ready, tap Mark checkpoint.`;
  }, [isScanning, sensorState, step, stepIndex]);

  const liveMetric = useMemo(() => {
    if (!isScanning || stepIndex === 0 || stepIndex === FINAL_SCAN_STEP_INDEX) {
      return step.target;
    }

    if (step.kind === 'turn') {
      return `${Math.round((step.turnDegrees || 90) * stepProgress)} deg`;
    }

    if (step.requiredPulses) {
      return `${Math.round(step.requiredPulses * stepProgress)} / ${step.requiredPulses} ${step.progressUnit || 'cues'}`;
    }

    return step.target;
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
    if (!isScanning || stepIndex >= FINAL_SCAN_STEP_INDEX || transitionLockRef.current) return;
    transitionLockRef.current = true;
    const nextIndex = stepIndex + 1;
    setStepIndex(nextIndex);
    setStepProgress(0);
    captureUsefulFrame();
    motionRef.current.pulses = 0;
    stepStartHeadingRef.current = orientationRef.current.heading;
    setLastEvent(`${source}. Next, ${GUIDANCE_STEPS[nextIndex].instruction}`);
  };
  advanceGuidanceRef.current = advanceGuidance;

  useEffect(() => {
    if (!isScanning || sensorState !== 'live' || stepIndex === FINAL_SCAN_STEP_INDEX) return undefined;

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

      if (step.kind === 'turn') {
        const turnAmount = Math.abs(headingDelta(stepStartHeadingRef.current ?? heading, heading));
        const requiredTurn = step.turnDegrees || 75;
        setStepProgress(Math.min(1, turnAmount / requiredTurn));
        if (turnAmount >= requiredTurn) {
          advanceGuidanceRef.current?.('Turn detected');
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

      const requiredPulses = step.requiredPulses || 4;
      setStepProgress(Math.min(1, motionRef.current.pulses / requiredPulses));
      if (step.kind !== 'turn' && motionRef.current.pulses >= requiredPulses) {
        advanceGuidanceRef.current?.('Movement detected');
      }
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    window.addEventListener('devicemotion', handleMotion, true);
    return () => {
      window.removeEventListener('deviceorientation', handleOrientation, true);
      window.removeEventListener('devicemotion', handleMotion, true);
    };
  }, [isScanning, sensorState, stepIndex, step.kind, step.requiredPulses, step.turnDegrees]);

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
    setViewMode('customize');
    setSensorState('idle');
    setStepIndex(FINAL_SCAN_STEP_INDEX);
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
      const hasMesh = typeof payload.meshPLY === 'string' && payload.meshPLY.startsWith('ply');
      if ((!Array.isArray(payload.frames) || payload.frames.length === 0) && !hasMesh) {
        throw new Error('No frames in scan session');
      }
      const frames = (Array.isArray(payload.frames) ? payload.frames : []).map((frame, index) => ({
        frameId: frame.frameId || frame.id || index + 1,
        capturedAt: frame.capturedAt || frame.timestamp || Date.now(),
        pose: frame.pose || {
          x: Number(frame.x || 0).toFixed(2),
          y: Number(frame.y || 1.42).toFixed(2),
          z: Number(frame.z || 0).toFixed(2),
          yaw: Math.round(Number(frame.yaw || 0) * (Math.abs(Number(frame.yaw || 0)) < 7 ? 180 / Math.PI : 1)).toString(),
          speed: '0.00',
          quality: 'ARKit tracked',
        },
        step: frame.step || 0,
        image: frame.image || '',
        previewUrl: frame.image || '',
      }));
      if (frames.length === 0 && !hasMesh) throw new Error('Scan data is missing');
      frameStoreRef.current.forEach((frame) => {
        if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
      });
      frameStoreRef.current = [];
      const importedSession = { ...payload, frames };
      setRoomSession(importedSession);
      setFramesCaptured(frames.length);
      setObjects(assetsFromSessionPayload(payload));
      setIsScanning(false);
      setIsFinished(true);
      setViewMode('customize');
      setCameraState('idle');
      setSensorState('idle');
      setStepIndex(FINAL_SCAN_STEP_INDEX);
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
          <span className="context-value">Room scan</span>
          <span className="context-divider" aria-hidden="true" />
          <span className={`status-dot ${isFinished ? 'status-dot-complete' : ''}`} />
          <span className="context-value">{isFinished ? 'Ready to review' : isScanning ? 'Scanning' : 'Not started'}</span>
        </div>

        <div className="topbar-actions">
          {roomSession && (
            <button className="quiet-button" type="button" onClick={() => setViewMode(viewMode === 'customize' ? 'scan' : 'customize')}>
              {viewMode === 'customize' ? 'Back to scan' : 'Room simulator'}
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
              <h1>{isFinished ? 'Ready to review your room.' : 'Scan the room with your phone.'}</h1>
            </div>
            <span className="phase-chip">Phase 01</span>
          </div>

          <section className="progress-panel" aria-label="Room scan capture progress">
            <div className="progress-heading">
              <span>Capture progress</span>
              <strong>{roomCoverage}%</strong>
            </div>
            <div className="progress-track" aria-hidden="true"><span style={{ width: `${roomCoverage}%` }} /></div>
            <div className="progress-footing">
              <span>{isFinished ? 'Ready to review' : stepIndex === FINAL_SCAN_STEP_INDEX ? 'Loop closed' : 'Following the room path'}</span>
              <span>{framesCaptured} useful frames</span>
            </div>
          </section>

          <section className={`instruction-panel ${isFinished ? 'instruction-panel-complete' : ''}`} aria-live="polite">
            <div className="instruction-topline">
              <span className="instruction-label">{step.label}</span>
              <span className="instruction-step">{stepIndex === 0 ? 'Ready' : isFinished ? 'Done' : `${Math.min(stepIndex, FINAL_SCAN_STEP_INDEX - 1)} / ${FINAL_SCAN_STEP_INDEX - 1}`}</span>
            </div>
            <div className="instruction-content">
              <div className="direction-glyph" aria-hidden="true">{step.direction}</div>
              <div>
                <p className="section-label">{step.eyebrow}</p>
                <h2>{step.title}</h2>
                <p className="instruction-copy">{instructionText}</p>
              </div>
            </div>
            <div className="instruction-meter-row">
              <span>{isFinished ? 'Scan quality' : 'Current target'}</span>
              <strong>{isFinished ? 'Ready' : liveMetric}</strong>
            </div>
            <div className="instruction-meter"><span style={{ width: `${isFinished ? 100 : stepProgress * 100}%` }} /></div>
            <p className="instruction-helper">{step.helper}{stepIndex === FINAL_SCAN_STEP_INDEX && !canFinish ? ` ${finishHint}` : ''}</p>
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
            {isScanning && stepIndex < FINAL_SCAN_STEP_INDEX && (
              <button className="primary-button" type="button" onClick={advanceGuidance}>
                Mark checkpoint <span className="checkpoint-arrow" aria-hidden="true">-&gt;</span>
              </button>
            )}
            {isScanning && stepIndex === FINAL_SCAN_STEP_INDEX && (
              <button className="primary-button" type="button" onClick={finishScan} disabled={!canFinish} title={finishHint}>
                Finish scan <span aria-hidden="true">-&gt;</span>
              </button>
            )}
            {isFinished && roomSession && (
              <button className="primary-button" type="button" onClick={() => setViewMode('customize')}>
                Open room simulator <span aria-hidden="true">-&gt;</span>
              </button>
            )}
            {!isFinished && stepIndex < FINAL_SCAN_STEP_INDEX && (
              <button className="secondary-button" type="button" onClick={finishScan} disabled={!canFinish} title={finishHint}>
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
          {isScanning && <p className="action-note action-note-guidance">{finishHint}</p>}
          {isFinished && <p className="action-note action-note-success">Your scan is now available in the 3D room viewer and can be loaded on desktop.</p>}
        </aside>
      </div>}
    </main>
  );
}

function roomDimensions(session) {
  const pathPoints = (session?.frames || []).map((frame) => ({
    x: Number(frame.pose?.x) || 0,
    z: Number(frame.pose?.z) || 0,
  }));
  const minX = Math.min(...pathPoints.map((point) => point.x), 0);
  const maxX = Math.max(...pathPoints.map((point) => point.x), 1);
  const minZ = Math.min(...pathPoints.map((point) => point.z), 0);
  const maxZ = Math.max(...pathPoints.map((point) => point.z), 1);
  return {
    pathPoints,
    minX,
    maxX,
    minZ,
    maxZ,
    width: clamp((maxX - minX) + 3.2, 4.8, 9.5),
    depth: clamp((maxZ - minZ) + 3.2, 4.8, 9.5),
    height: 2.8,
  };
}

function parsePLYGeometry(plyText) {
  if (typeof plyText !== 'string' || !plyText.startsWith('ply')) return null;
  const lines = plyText.split(/\r?\n/);
  const headerEnd = lines.indexOf('end_header');
  if (headerEnd < 0) return null;
  const vertexCount = Number(lines.find((line) => line.startsWith('element vertex '))?.split(' ')[2]);
  const faceCount = Number(lines.find((line) => line.startsWith('element face '))?.split(' ')[2]);
  if (!Number.isFinite(vertexCount) || !Number.isFinite(faceCount)) return null;

  const vertices = [];
  for (let index = 0; index < vertexCount; index += 1) {
    const values = lines[headerEnd + 1 + index]?.trim().split(/\s+/).map(Number);
    if (!values || values.length < 3 || values.some((value) => !Number.isFinite(value))) return null;
    vertices.push(values[0], values[1], values[2]);
  }

  const faceBuckets = new Map();
  for (let index = 0; index < faceCount; index += 1) {
    const values = lines[headerEnd + 1 + vertexCount + index]?.trim().split(/\s+/).map(Number);
    if (!values || values.length < 4 || values[0] < 3) continue;
    const classification = Number.isFinite(values[4]) ? values[4] : 0;
    if (!faceBuckets.has(classification)) faceBuckets.set(classification, []);
    faceBuckets.get(classification).push(values[1], values[2], values[3]);
  }
  if (vertices.length === 0 || faceBuckets.size === 0) return null;

  const indices = [];
  const surfaceKeys = [];
  const surfaceNames = ['other', 'wall', 'floor', 'ceiling', 'table', 'seat', 'window', 'door'];
  const geometry = new THREE.BufferGeometry();
  faceBuckets.forEach((bucket, classification) => {
    const start = indices.length;
    indices.push(...bucket);
    geometry.addGroup(start, bucket.length, surfaceKeys.length);
    surfaceKeys.push(surfaceNames[classification] || 'other');
  });
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData.surfaceKeys = surfaceKeys;
  return geometry;
}

function assetFromDetection(observation, index) {
  const label = String(observation?.label || `Detected object ${index + 1}`);
  const normalized = label.toLowerCase();
  const kind = normalized.includes('bed') ? 'bed'
    : normalized.includes('desk') || normalized.includes('table') ? 'desk'
      : normalized.includes('chair') || normalized.includes('seat') || normalized.includes('sofa') || normalized.includes('couch') ? 'chair'
        : 'generic';
  const position = Number.isFinite(Number(observation?.x)) && Number.isFinite(Number(observation?.z))
    ? { x: Number(observation.x), z: Number(observation.z) }
    : undefined;
  return {
    name: label.replace(/\b\w/g, (character) => character.toUpperCase()),
    kind,
    coverage: 0,
    confidence: `${Math.round((Number(observation?.confidence) || 0) * 100)}% AI match`,
    position,
  };
}

function assetsFromSessionPayload(payload) {
  if (Array.isArray(payload.objects) && payload.objects.length > 0) return payload.objects;
  if (Array.isArray(payload.detectedObjects) && payload.detectedObjects.length > 0) {
    const bestByLabel = new Map();
    payload.detectedObjects.forEach((observation) => {
      const key = String(observation?.label || '').toLowerCase();
      const current = bestByLabel.get(key);
      if (!current || Number(observation?.confidence) > Number(current?.confidence)) bestByLabel.set(key, observation);
    });
    return [...bestByLabel.values()].map(assetFromDetection);
  }
  const summary = payload.surfaceSummary || {};
  const classifiedAssets = [];
  if (summary.table) classifiedAssets.push({ name: 'Table (ARKit)', kind: 'desk', coverage: 0, confidence: 'ARKit mesh class' });
  if (summary.seat) classifiedAssets.push({ name: 'Seat (ARKit)', kind: 'chair', coverage: 0, confidence: 'ARKit mesh class' });
  if (summary.window) classifiedAssets.push({ name: 'Window (ARKit)', kind: 'window', coverage: 0, confidence: 'ARKit mesh class' });
  return classifiedAssets.length > 0 ? classifiedAssets : INITIAL_OBJECTS.map((object) => ({ ...object }));
}

function disposeRoomScene(scene) {
  scene.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (!child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (material.map) material.map.dispose();
      material.dispose();
    });
  });
}

function RoomScene({ session, objects, selectedAssetName, assetScale, assetColor, assetPosition, activeFrameIndex, surfaceColors }) {
  const viewportRef = useRef(null);
  const canvasRef = useRef(null);
  const arSessionRef = useRef(null);
  const enterARRef = useRef(null);
  const [arSupport, setArSupport] = useState('checking');
  const [arActive, setArActive] = useState(false);
  const [arError, setArError] = useState('');
  const [sceneError, setSceneError] = useState('');

  useEffect(() => {
    let mounted = true;
    if (!navigator.xr?.isSessionSupported) {
      setArSupport('unavailable');
      return undefined;
    }
    navigator.xr.isSessionSupported('immersive-ar')
      .then((supported) => {
        if (mounted) setArSupport(supported ? 'supported' : 'unavailable');
      })
      .catch(() => {
        if (mounted) setArSupport('unavailable');
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return undefined;

    let disposed = false;
    const scene = new THREE.Scene();
    const backgroundColor = new THREE.Color('#1a1c19');
    scene.background = backgroundColor;
    scene.fog = new THREE.Fog(backgroundColor, 8, 18);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 40);
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (error) {
      setSceneError('This browser cannot render the 3D room. Your captured views are still available below.');
      return undefined;
    }
    setSceneError('');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const dimensions = roomDimensions(session);
    const scanMeshGeometry = parsePLYGeometry(session.meshPLY);
    let { pathPoints, minX, maxX, minZ, maxZ } = dimensions;
    let { width, depth, height } = dimensions;
    let roomOffset = new THREE.Vector3();
    if (scanMeshGeometry) {
      scanMeshGeometry.computeBoundingBox();
      const bounds = scanMeshGeometry.boundingBox;
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      width = clamp(size.x, 3.5, 12);
      depth = clamp(size.z, 3.5, 12);
      height = clamp(size.y, 2.3, 4.2);
      roomOffset = new THREE.Vector3(-center.x, -bounds.min.y, -center.z);
    }
    const room = new THREE.Group();
    room.position.copy(roomOffset);
    scene.add(room);

    const addBox = (parent, size, position, material, castShadow = true, receiveShadow = true) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...position);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      parent.add(mesh);
      return mesh;
    };

    scene.add(new THREE.HemisphereLight('#f4e9d5', '#2b302d', 2.1));
    const keyLight = new THREE.DirectionalLight('#ffe9c4', 2.8);
    keyLight.position.set(3, 5, 4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);
    const fillLight = new THREE.PointLight('#a7c1bd', 1.2, 10);
    fillLight.position.set(-2, 2.2, 1.5);
    scene.add(fillLight);

    const materialColor = (surface) => surfaceColors?.[surface] || (surface === 'floor' ? '#59615a' : '#737a71');
    if (scanMeshGeometry) {
      const surfaceMaterialColors = {
        other: '#747970',
        wall: materialColor('wall'),
        floor: materialColor('floor'),
        ceiling: materialColor('ceiling'),
        table: '#8b806c',
        seat: '#8a7465',
        window: '#7ea8ae',
        door: '#796e60',
      };
      const surfaceMaterials = (scanMeshGeometry.userData.surfaceKeys || ['other']).map((surface) => new THREE.MeshStandardMaterial({
        color: surfaceMaterialColors[surface] || surfaceMaterialColors.other,
        roughness: surface === 'window' ? 0.24 : 0.88,
        metalness: surface === 'window' ? 0.12 : 0,
        transparent: surface === 'window',
        opacity: surface === 'window' ? 0.78 : 1,
        side: THREE.DoubleSide,
      }));
      const scanMesh = new THREE.Mesh(scanMeshGeometry, surfaceMaterials);
      scanMesh.castShadow = false;
      scanMesh.receiveShadow = true;
      room.add(scanMesh);
    } else {
      const floorMaterial = new THREE.MeshStandardMaterial({ color: materialColor('floor'), roughness: 0.88, metalness: 0.02 });
      addBox(room, [width, 0.12, depth], [0, -0.06, 0], floorMaterial, false, true);
      const wallMaterial = new THREE.MeshStandardMaterial({ color: materialColor('wall'), roughness: 0.92, metalness: 0 });
      addBox(room, [width, height, 0.12], [0, height / 2, -depth / 2], wallMaterial, false, true);
      addBox(room, [0.12, height, depth], [-width / 2, height / 2, 0], wallMaterial, false, true);
      addBox(room, [0.12, height, depth], [width / 2, height / 2, 0], wallMaterial, false, true);
    }

    const gridSize = Math.max(width, depth);
    const grid = new THREE.GridHelper(gridSize, Math.round(gridSize * 2), '#b9b29e', '#7c8379');
    grid.position.y = 0.012;
    grid.scale.set(width / gridSize, 1, depth / gridSize);
    grid.material.transparent = true;
    grid.material.opacity = 0.22;
    room.add(grid);

    const pathRangeX = Math.max(maxX - minX, 0.5);
    const pathRangeZ = Math.max(maxZ - minZ, 0.5);
    const toRoomPoint = scanMeshGeometry
      ? (point) => new THREE.Vector3(point.x, 0.08, point.z)
      : (point) => new THREE.Vector3(
        (((point.x - minX) / pathRangeX) - 0.5) * (width - 0.7),
        0.08,
        (((point.z - minZ) / pathRangeZ) - 0.5) * (depth - 0.7),
      );
    const roomPath = pathPoints.map(toRoomPoint);
    if (roomPath.length > 1) {
      const pathLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(roomPath),
        new THREE.LineBasicMaterial({ color: '#ffc27c', transparent: true, opacity: 0.88 }),
      );
      room.add(pathLine);
    }
    const pathNodeMaterial = new THREE.MeshBasicMaterial({ color: '#9bd8b1' });
    roomPath.forEach((point) => {
      const node = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), pathNodeMaterial);
      node.position.copy(point);
      room.add(node);
    });

    const captureSlots = [
      { x: 0, y: 1.55, z: -depth / 2 + 0.08, rotationY: 0, width: Math.min(width * 0.68, 4.2) },
      { x: -width / 2 + 0.08, y: 1.5, z: 0, rotationY: Math.PI / 2, width: Math.min(depth * 0.62, 3.6) },
      { x: width / 2 - 0.08, y: 1.5, z: 0, rotationY: -Math.PI / 2, width: Math.min(depth * 0.62, 3.6) },
      { x: 0, y: 1.55, z: depth / 2 - 0.08, rotationY: Math.PI, width: Math.min(width * 0.68, 4.2) },
    ];
    const textureLoader = new THREE.TextureLoader();
    const capturedFrames = (session.frames || []).filter((frame) => frameSource(frame)).slice(0, captureSlots.length);
    capturedFrames.forEach((frame, index) => {
      const slot = captureSlots[index];
      const texture = textureLoader.load(frameSource(frame), (loadedTexture) => {
        if (disposed) {
          loadedTexture.dispose();
          return;
        }
        loadedTexture.colorSpace = THREE.SRGBColorSpace;
        const imageAspect = loadedTexture.image?.width && loadedTexture.image?.height
          ? loadedTexture.image.width / loadedTexture.image.height
          : 1.5;
        const panelHeight = Math.min(slot.width / imageAspect, 1.75);
        const panelMaterial = new THREE.MeshBasicMaterial({ map: loadedTexture, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(slot.width, panelHeight), panelMaterial);
        panel.position.set(slot.x, slot.y, slot.z);
        panel.rotation.y = slot.rotationY;
        room.add(panel);

        const borderMaterial = new THREE.LineBasicMaterial({ color: index === activeFrameIndex ? '#ffc27c' : '#e3ddce', transparent: true, opacity: index === activeFrameIndex ? 0.95 : 0.42 });
        const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(slot.width + 0.05, panelHeight + 0.05)), borderMaterial);
        border.position.copy(panel.position);
        border.rotation.copy(panel.rotation);
        room.add(border);
      });
      texture.colorSpace = THREE.SRGBColorSpace;
    });

    const roomObjects = objects?.length ? objects : INITIAL_OBJECTS;
    const defaultSlots = [
      { x: -width * 0.24, z: -depth * 0.22 },
      { x: width * 0.2, z: -depth * 0.22 },
      { x: width * 0.2, z: depth * 0.2 },
      { x: -width * 0.22, z: depth * 0.2 },
    ];
    const selectedX = clamp(((assetPosition.x / 100) - 0.5) * (width - 1), -width / 2 + 0.5, width / 2 - 0.5);
    const selectedZ = clamp(((assetPosition.y / 100) - 0.5) * (depth - 1), -depth / 2 + 0.5, depth / 2 - 0.5);
    const furnitureColors = ['#b39a80', '#7d8d88', '#a7a08c', '#78929a'];
    roomObjects.forEach((object, index) => {
      const isSelected = object.name === selectedAssetName;
      const slot = defaultSlots[index % defaultSlots.length];
      const furniture = new THREE.Group();
      const material = new THREE.MeshStandardMaterial({ color: isSelected ? assetColor : furnitureColors[index % furnitureColors.length], roughness: 0.72, metalness: 0.04, emissive: isSelected ? assetColor : '#000000', emissiveIntensity: isSelected ? 0.14 : 0 });
      const addPart = (size, position, partMaterial = material, castShadow = true, receiveShadow = true) => addBox(furniture, size, position, partMaterial, castShadow, receiveShadow);

      if (object.kind === 'bed') {
        addPart([2.15, 0.28, 1.18], [0, 0.28, 0]);
        addPart([2.04, 0.22, 1.08], [0, 0.53, 0], new THREE.MeshStandardMaterial({ color: isSelected ? assetColor : '#c7c0ad', roughness: 0.96 }));
        addPart([0.42, 0.12, 0.74], [-0.65, 0.73, -0.08], new THREE.MeshStandardMaterial({ color: '#e3ddce', roughness: 0.98 }));
      } else if (object.kind === 'desk') {
        addPart([1.55, 0.14, 0.68], [0, 0.94, 0]);
        [-0.62, 0.62].forEach((x) => addPart([0.1, 0.92, 0.1], [x, 0.46, -0.24]));
        [-0.62, 0.62].forEach((x) => addPart([0.1, 0.92, 0.1], [x, 0.46, 0.24]));
      } else if (object.kind === 'chair') {
        addPart([0.72, 0.14, 0.72], [0, 0.68, 0]);
        addPart([0.72, 0.9, 0.12], [0, 1.08, -0.3]);
        [-0.26, 0.26].forEach((x) => addPart([0.09, 0.66, 0.09], [x, 0.33, -0.24]));
        [-0.26, 0.26].forEach((x) => addPart([0.09, 0.66, 0.09], [x, 0.33, 0.24]));
      } else if (object.kind === 'window') {
        const glassMaterial = new THREE.MeshStandardMaterial({ color: '#a6ccd0', roughness: 0.18, metalness: 0.12, transparent: true, opacity: 0.78 });
        addPart([1.55, 1.15, 0.08], [0, 1.65, 0], glassMaterial, false, false);
        addPart([1.7, 0.1, 0.12], [0, 2.25, 0]);
        addPart([1.7, 0.1, 0.12], [0, 1.05, 0]);
        addPart([0.1, 1.2, 0.12], [-0.8, 1.65, 0]);
        addPart([0.1, 1.2, 0.12], [0.8, 1.65, 0]);
      } else {
        addPart([1.1, 0.8, 0.8], [0, 0.4, 0]);
        addPart([0.92, 0.18, 0.72], [0, 0.88, 0], new THREE.MeshStandardMaterial({ color: '#c7c0ad', roughness: 0.96 }));
      }

      const detectedSlot = Number.isFinite(Number(object.position?.x)) && Number.isFinite(Number(object.position?.z))
        ? { x: Number(object.position.x), z: Number(object.position.z) }
        : slot;
      furniture.position.set(isSelected ? selectedX : detectedSlot.x, 0, isSelected ? selectedZ : detectedSlot.z);
      furniture.scale.setScalar(isSelected ? assetScale : 0.92);
      if (object.kind === 'window') furniture.position.z = isSelected ? selectedZ : -depth / 2 + 0.16;
      if (isSelected) {
        const selectionRing = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.5, 32), new THREE.MeshBasicMaterial({ color: '#ffc27c', transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
        selectionRing.rotation.x = -Math.PI / 2;
        selectionRing.position.y = 0.015;
        furniture.add(selectionRing);
      }
      room.add(furniture);
    });

    const orbit = { azimuth: 0, elevation: 0.2, distance: Math.max(width, depth) * 0.92 };
    const target = new THREE.Vector3(0, 1.05, 0);
    const updateCamera = () => {
      const horizontalDistance = Math.cos(orbit.elevation) * orbit.distance;
      camera.position.set(Math.sin(orbit.azimuth) * horizontalDistance, target.y + Math.sin(orbit.elevation) * orbit.distance, Math.cos(orbit.azimuth) * horizontalDistance);
      camera.lookAt(target);
    };
    updateCamera();

    const pointer = { active: false, x: 0, y: 0 };
    const handlePointerDown = (event) => {
      pointer.active = true;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    };
    const handlePointerMove = (event) => {
      if (!pointer.active || renderer.xr.isPresenting) return;
      orbit.azimuth -= (event.clientX - pointer.x) * 0.008;
      orbit.elevation = clamp(orbit.elevation + (event.clientY - pointer.y) * 0.006, -0.05, 0.82);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      updateCamera();
    };
    const handlePointerUp = () => {
      pointer.active = false;
    };
    const handleWheel = (event) => {
      if (renderer.xr.isPresenting) return;
      event.preventDefault();
      orbit.distance = clamp(orbit.distance + event.deltaY * 0.006, 3.5, 12);
      updateCamera();
    };
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    const resize = () => {
      const bounds = viewport.getBoundingClientRect();
      const sceneWidth = Math.max(bounds.width, 1);
      const sceneHeight = Math.max(bounds.height, 1);
      renderer.setSize(sceneWidth, sceneHeight, false);
      camera.aspect = sceneWidth / sceneHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    renderer.setAnimationLoop(() => renderer.render(scene, camera));

    const enterAR = async () => {
      if (!navigator.xr || arSupport !== 'supported' || arSessionRef.current) return;
      try {
        setArError('');
        const xrSession = await navigator.xr.requestSession('immersive-ar', { optionalFeatures: ['local-floor', 'dom-overlay'], domOverlay: { root: viewport } });
        if (disposed) {
          xrSession.end();
          return;
        }
        renderer.xr.enabled = true;
        renderer.xr.setReferenceSpaceType('local-floor');
        await renderer.xr.setSession(xrSession);
        scene.background = null;
        scene.fog = null;
        arSessionRef.current = xrSession;
        setArActive(true);
        const handleSessionEnd = () => {
          arSessionRef.current = null;
          renderer.xr.enabled = false;
          scene.background = backgroundColor;
          scene.fog = new THREE.Fog(backgroundColor, 8, 18);
          if (!disposed) setArActive(false);
        };
        xrSession.addEventListener('end', handleSessionEnd, { once: true });
      } catch (error) {
        setArError('AR could not start. The 3D room is still available here.');
      }
    };
    enterARRef.current = enterAR;

    return () => {
      disposed = true;
      enterARRef.current = null;
      if (arSessionRef.current) arSessionRef.current.end().catch(() => {});
      renderer.setAnimationLoop(null);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('wheel', handleWheel);
      window.removeEventListener('resize', resize);
      disposeRoomScene(scene);
      renderer.dispose();
    };
  }, [session, objects, selectedAssetName, assetScale, assetColor, assetPosition, activeFrameIndex, surfaceColors, arSupport]);

  const enterAR = () => enterARRef.current?.();
  const exitAR = () => arSessionRef.current?.end();

  return (
    <div className={`room-scene-viewport ${arActive ? 'room-scene-viewport-ar' : ''}`} ref={viewportRef}>
      <canvas className="room-scene-canvas" ref={canvasRef} aria-label="Interactive 3D room built from the scan path and captured views" />
      {sceneError && <p className="room-scene-empty">{sceneError}</p>}
      <div className="room-scene-toolbar">
        <span>{arActive ? 'Move your phone to view the room in AR.' : 'Drag to look around. Scroll to zoom.'}</span>
        {arSupport === 'supported' && !arActive && <button type="button" className="scene-ar-button" onClick={enterAR}>Enter AR</button>}
        {arActive && <button type="button" className="scene-ar-button" onClick={exitAR}>Exit AR</button>}
        {arSupport === 'checking' && <span className="scene-capability">Checking AR...</span>}
        {arSupport === 'unavailable' && <span className="scene-capability">3D room</span>}
      </div>
      {arError && <p className="room-scene-error">{arError}</p>}
    </div>
  );
}

function RoomCustomizer({ session, objects, onExport, isExporting }) {
  const previewVideoRef = useRef(null);
  const previewStreamRef = useRef(null);
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const [selectedAssetName, setSelectedAssetName] = useState(objects[0]?.name || 'Bed');
  const [assetColor, setAssetColor] = useState('#d8b08a');
  const [assetScale, setAssetScale] = useState(1);
  const [assetPosition, setAssetPosition] = useState({ x: 53, y: 57 });
  const [surfaceColors, setSurfaceColors] = useState({ wall: '#737a71', floor: '#59615a', ceiling: '#9a9c92' });
  const [isCameraPreview, setIsCameraPreview] = useState(false);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    return () => {
      if (previewStreamRef.current) {
        previewStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const selectedAsset = objects.find((object) => object.name === selectedAssetName) || objects[0];

  const updateAssetPosition = (axis, value) => {
    setAssetPosition((current) => ({ ...current, [axis]: Number(value) }));
  };

  const updateSurfaceColor = (surface, color) => {
    setSurfaceColors((current) => ({ ...current, [surface]: color }));
  };

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
          <p className="section-label">Scanned room simulator</p>
          <h1>Walk through your scanned room.</h1>
          <p className="customizer-intro">Explore the estimated room in 3D, review captured views, or place furniture.</p>
        </div>
        <div className="customizer-header-actions">
          <span className="session-chip">{session.frames.length} keyframes</span>
          <button className="secondary-button" type="button" onClick={onExport} disabled={isExporting}>
            {isExporting ? 'Preparing...' : 'Export session'}
          </button>
        </div>
      </div>

      <div className="customizer-grid">
        <section className="customizer-stage-panel" aria-label="Scanned room simulator">
          <div className={`customizer-stage ${isCameraPreview ? 'customizer-stage-camera' : ''}`}>
            {isCameraPreview ? (
              <video ref={previewVideoRef} className="customizer-camera" autoPlay muted playsInline />
            ) : (
              <RoomScene
                session={session}
                objects={objects}
                selectedAssetName={selectedAssetName}
                assetScale={assetScale}
                assetColor={assetColor}
                assetPosition={assetPosition}
                activeFrameIndex={activeFrameIndex}
                surfaceColors={surfaceColors}
              />
            )}
            <div className="customizer-stage-shade" />
            <div className="customizer-stage-meta">
              <span>{isCameraPreview ? 'CAMERA OVERLAY' : session.meshPLY ? 'LIDAR ROOM MESH' : 'ESTIMATED ROOM'}</span>
              <span>{selectedAsset?.name || 'Room asset'} / PLACED</span>
            </div>
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
              <p className="section-label">Simulator controls</p>
              <h2>Room assets</h2>
            </div>
            <span className="tracking-badge tracking-badge-live">{session.meshPLY ? 'LiDAR mesh' : 'Estimated room'}</span>
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

          <div className="surface-materials">
            <div className="customizer-slider-label"><span>Room surfaces</span><strong>EDITABLE</strong></div>
            {Object.entries(surfaceColors).map(([surface, color]) => (
              <div className="surface-material-row" key={surface}>
                <span>{surface.charAt(0).toUpperCase() + surface.slice(1)}</span>
                <div className="color-picker">
                  {['#737a71', '#59615a', '#a5a091', '#8b7465', '#6f8f8e'].map((swatch) => (
                    <button className={`color-swatch ${color === swatch ? 'color-swatch-active' : ''}`} style={{ backgroundColor: swatch }} type="button" key={swatch} onClick={() => updateSurfaceColor(surface, swatch)} aria-label={`Set ${surface} to ${swatch}`} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <label className="customizer-slider-label" htmlFor="asset-position-x">
            <span>Horizontal placement</span><strong>{Math.round(assetPosition.x)}%</strong>
          </label>
          <input id="asset-position-x" className="customizer-slider" type="range" min="15" max="85" step="1" value={assetPosition.x} onChange={(event) => updateAssetPosition('x', event.target.value)} />

          <label className="customizer-slider-label" htmlFor="asset-position-y">
            <span>Depth placement</span><strong>{Math.round(assetPosition.y)}%</strong>
          </label>
          <input id="asset-position-y" className="customizer-slider" type="range" min="18" max="82" step="1" value={assetPosition.y} onChange={(event) => updateAssetPosition('y', event.target.value)} />

          <div className="room-map-panel">
            <div className="panel-heading-row"><div><p className="section-label">Captured path</p><h2>Room footprint</h2></div><span className="object-count">{session.meshPLY ? 'LiDAR mesh' : 'Estimated'}</span></div>
            <svg className="room-map" viewBox="0 0 100 100" role="img" aria-label="Estimated room scan path">
              <rect x="8" y="8" width="84" height="84" rx="2" />
              <polyline points={pathPolyline} />
              {pathPoints.length > 0 && <circle cx={lastPathCoordinate?.[0]} cy={lastPathCoordinate?.[1]} r="3" />}
            </svg>
          </div>

          <button className="primary-button customizer-camera-button" type="button" onClick={toggleCameraPreview}>
            {isCameraPreview ? 'Close camera overlay' : 'Preview with camera'} <span aria-hidden="true">-&gt;</span>
          </button>
          {previewError && <p className="action-note action-note-error">{previewError}</p>}
          <p className="customizer-disclaimer">This room is built from your movement path and captured views. Precise wall geometry needs depth capture or a reconstruction service; AR needs a WebXR-capable browser.</p>
        </aside>
      </div>
    </div>
  );
}

function TelemetryValue({ label, value }) {
  return <div className="telemetry-value"><span>{label}</span><strong>{value}</strong></div>;
}

export default App;
